import type { App, AppDeps } from "./app-types.ts";
import { personOrOwningBot, type CapabilityClaims } from "../auth/capability-token.ts";
import type { ScopeId } from "../types.ts";
import { samePersonInDirectory } from "../directory/person.ts";
import {
  createMembershipControlsScope,
  createCanManageScope,
  scopeMembershipSnapshot,
} from "../resolution/scope-membership.ts";
import type { TriggerBase } from "../triggers/types.ts";

export async function canAdministerLoop(
  app: Pick<App, "membershipControlsScope" | "managesScope" | "samePerson">,
  loop: Pick<TriggerBase, "owner" | "ownerScopeId" | "botActor">,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
): Promise<boolean> {
  const { actorId } = actor;
  if (!(await personOrOwningBot(actor, async () => app.samePerson(loop.owner, actorId), loop))) return false;
  if (await app.membershipControlsScope(loop.ownerScopeId)) return app.managesScope(actorId, loop.ownerScopeId);
  if (await app.samePerson(loop.owner, actorId)) return true;
  return app.managesScope(actorId, loop.ownerScopeId);
}

export async function loopAdministration(
  deps: AppDeps,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
  loops: readonly Pick<TriggerBase, "owner" | "ownerScopeId" | "botActor">[],
) {
  if (!loops.length) return [];
  const { actorId } = actor;
  const snapshot = await scopeMembershipSnapshot(
    {
      directory: deps.directory,
      identity: deps.identity,
      ...(deps.projects ? { managedGroups: deps.projects } : {}),
      ...(deps.personas ? { personas: deps.personas } : {}),
    },
    actorId,
    loops.map((loop) => loop.ownerScopeId),
    loops.map((loop) => loop.owner),
  );
  const manages = createCanManageScope(snapshot);
  const policy = {
    membershipControlsScope: createMembershipControlsScope(snapshot),
    managesScope: (_actor: string, scope: ScopeId) => manages(actorId, scope),
    samePerson: (a: string, b: string) => samePersonInDirectory(snapshot.directory, a, b),
  };
  return Promise.all(loops.map((loop) => canAdministerLoop(policy, loop, actor)));
}
