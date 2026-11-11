import type { App, AppDeps } from "./app-types.ts";
import { personOrOwningBot, type CapabilityClaims } from "../auth/capability-token.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import { canonicalPerson, samePersonInDirectory } from "../directory/person.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";
import { createMembershipControlsScope, createCanManageScope } from "../resolution/scope-membership.ts";
import { swallowAs } from "../util/errors.ts";

export async function canAdministerLoop(
  app: Pick<App, "membershipControlsScope" | "managesScope" | "samePerson">,
  loop: { owner: string; ownerScopeId: ScopeId },
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
): Promise<boolean> {
  const { actorId } = actor;
  if (!(await personOrOwningBot(actor, async () => app.samePerson(loop.owner, actorId)))) return false;
  if (await app.membershipControlsScope(loop.ownerScopeId)) return app.managesScope(actorId, loop.ownerScopeId);
  if (await app.samePerson(loop.owner, actorId)) return true;
  return app.managesScope(actorId, loop.ownerScopeId);
}

export async function loopAdministration(
  deps: AppDeps,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
  loops: readonly { owner: string; ownerScopeId: ScopeId }[],
) {
  if (!loops.length) return [];
  const { actorId } = actor;
  const scopes = [...new Set(loops.map((loop) => loop.ownerScopeId))];
  const ids = [...new Set([actorId, ...loops.map((loop) => loop.owner)].flatMap((id) => [id, canonicalPerson(id)]))];
  const members = await deps.directory
    .getMany(ids)
    .catch(swallowAs("loop administration: directory lookup", new Map<string, DirectoryMember>()));
  const member = members.get(actorId);
  const aliases = [...new Set([actorId, member?.principalId, member?.slackId].filter((id): id is string => !!id))];
  const groups = scopes.flatMap((scope) => {
    const { kind, ref } = parseScopeId(scope);
    return kind === "group" ? [ref] : [];
  });
  const hasChannels = scopes.some((scope) => parseScopeId(scope).kind === "channel");
  const hasPersonas = scopes.some((scope) => parseScopeId(scope).kind === "persona");
  const [channels, joinedChannels, joinedGroups, projects, roles] = await Promise.all([
    hasChannels ? deps.directory.listChannels() : [],
    hasChannels
      ? Promise.all(
          aliases.map(
            async (id) =>
              [
                id,
                new Set(
                  (await deps.directory.listChannelsFor(id))
                    .filter((c) => c.isPrivate === true)
                    .map((c) => c.channelId),
                ),
              ] as const,
          ),
        )
      : [],
    groups.length
      ? Promise.all(aliases.map(async (id) => [id, new Set(await deps.directory.listGroupsFor(id))] as const))
      : [],
    deps.projects?.membersMany(groups),
    hasPersonas ? deps.personas?.roles(actorId) : undefined,
  ]);
  const privateById = new Map(channels.map((channel) => [channel.channelId, channel.isPrivate]));
  const channelsByActor = new Map(joinedChannels);
  const groupsByActor = new Map(joinedGroups);
  const snapshot = {
    identity: deps.identity,
    directory: {
      ...deps.directory,
      get: async (id: string) => members.get(id) ?? null,
      channelPrivacy: async (id: string) => privateById.get(id),
      channelMember: async (ref: string, id: string) => channelsByActor.get(id)?.has(ref) ?? false,
      groupMember: async (ref: string, id: string) => groupsByActor.get(id)?.has(ref) ?? false,
    },
    ...(deps.projects
      ? {
          managedGroups: {
            ...deps.projects,
            membership: async (ref: string, id: string) => projects?.get(ref)?.includes(id),
          },
        }
      : {}),
    ...(deps.personas
      ? { personas: { role: async (_id: string, persona: string) => roles?.get(persona) ?? null } }
      : {}),
  };
  const controls = createMembershipControlsScope(snapshot);
  const manages = createCanManageScope(snapshot);
  const permissions = new Map(
    await Promise.all(
      scopes.map(
        async (scope) => [scope, { controls: await controls(scope), manages: await manages(actorId, scope) }] as const,
      ),
    ),
  );
  const policy = {
    membershipControlsScope: async (scope: ScopeId) => permissions.get(scope)!.controls,
    managesScope: async (_actor: string, scope: ScopeId) => permissions.get(scope)!.manages,
    samePerson: (a: string, b: string) => samePersonInDirectory(snapshot.directory, a, b),
  };
  return Promise.all(loops.map((loop) => canAdministerLoop(policy, loop, actor)));
}
