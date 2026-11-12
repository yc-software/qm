import type { Principal, ScopeId } from "../types.ts";
import { atLeast, type PersonaRole } from "../personas/persona-schema.ts";
import { actsAsScope, parseScopeId, scopeId } from "../types.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import type {
  ChannelMembershipFacts,
  DirectoryMember,
  DirectoryStore,
  ScopeMembershipFacts,
} from "../directory/directory-store.ts";
import { swallowAs } from "../util/errors.ts";
import { type Tenant, ambientTenant } from "../tenants/context.ts";
import { orgId } from "../config.ts";
import { conversationScope } from "./resolution-service.ts";
import { externalSlackRequestAllowed, type ExternalSlackPolicies } from "./external-slack.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";

export interface ManagedGroupDirectory {
  recognizes(groupId: string): boolean;
  membership(groupId: string, principalId: string): Promise<boolean | undefined>;
  members(groupId: string): Promise<string[] | undefined>;
  version(groupId: string): Promise<string | undefined>;
  withVersion<T>(groupId: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  slackChannel?(groupId: string): Promise<{ channelId: string; channelName: string } | undefined>;
}

export interface ScopeMembershipDeps {
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "membership" | "members">;
  directory?: {
    channelMember(channelId: string, principalId: string): Promise<boolean>;
    groupMember(groupId: string, principalId: string): Promise<boolean>;
    channelMembership(channelId: string, principalId: string): Promise<boolean | undefined>;
    groupMembership(groupId: string, principalId: string): Promise<boolean | undefined>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
    rosterCoversAudience?(channelId: string): Promise<boolean | undefined>;
    conversationMembers?(
      kind: "channel" | "group",
      id: string,
    ): Promise<Array<{ principalId: string; displayName?: string; type: string }> | undefined>;
    list?(): Promise<Array<{ principalId: string; displayName?: string }>>;
    get?(principalId: string): Promise<{ principalId?: string; slackId?: string } | null>;
  };
  identity?: {
    classify(externalId: string, isExternalGuest?: boolean): { type?: string; teamIds?: readonly string[] };
  };
  teams?: { isMember(tenant: Tenant, principalId: string, teamId: string): Promise<boolean> };
  sessions?: { participantScopes(principalId: string): Promise<readonly { scopeId: ScopeId }[]> };
  personas?: { role(principalId: string, personaId: string): Promise<PersonaRole | null> };
}

async function personaRoleAtLeast(
  deps: ScopeMembershipDeps,
  principalId: string,
  personaId: string,
  floor: PersonaRole,
): Promise<boolean> {
  return atLeast(await deps.personas?.role(principalId, personaId), floor);
}

async function teamMember(deps: ScopeMembershipDeps, principalId: string, teamId: string): Promise<boolean> {
  return (
    activePrincipal(deps, principalId) && (await deps.teams?.isMember(ambientTenant(), principalId, teamId)) === true
  );
}

function activePrincipal(deps: ScopeMembershipDeps, principalId: string): boolean {
  const type = deps.identity?.classify(principalId).type;
  return type === undefined || type === "internal";
}

async function channelPrivacy(deps: ScopeMembershipDeps, ref: string): Promise<boolean | undefined> {
  return deps.directory?.channelPrivacy?.(ref).catch(swallowAs("scope membership: channel privacy", undefined));
}

async function currentSharedScopeMember(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean> {
  if (actsAsScope(principalId, scopeId(kind, ref))) return true;
  if (!activePrincipal(deps, principalId)) return false;
  const member = await deps.directory?.get?.(principalId).catch(swallowAs("scope membership: directory lookup", null));
  const ids = [...new Set([principalId, member?.principalId, member?.slackId].filter((id): id is string => !!id))];
  const managed = kind === "group" && deps.managedGroups?.recognizes(ref);
  const membership = (id: string) => {
    if (managed) return deps.managedGroups!.membership(ref, id);
    return kind === "channel" ? deps.directory?.channelMember(ref, id) : deps.directory?.groupMember(ref, id);
  };
  for (const id of ids)
    if (
      (await membership(id)?.catch(swallowAs(`scope membership: ${managed ? "managed group" : kind}`, false))) === true
    )
      return true;
  return false;
}

async function sharedScopeMembership(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean | undefined> {
  if (actsAsScope(principalId, scopeId(kind, ref))) return true;
  if (!activePrincipal(deps, principalId)) return false;
  if (kind === "group" && deps.managedGroups?.recognizes(ref))
    return (
      (await deps.managedGroups
        .membership(ref, principalId)
        .catch(swallowAs("scope membership: managed group", false))) === true
    );
  const membership =
    kind === "channel"
      ? deps.directory?.channelMembership(ref, principalId)
      : deps.directory?.groupMembership(ref, principalId);
  return membership?.catch(swallowAs(`scope membership: ${kind}`, undefined));
}

async function memberOfSharedScope(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
  fullScope: ScopeId,
): Promise<boolean> {
  const current = await sharedScopeMembership(deps, kind, ref, principalId);
  if (current !== undefined) return current;
  return (
    (
      await deps.sessions?.participantScopes(principalId).catch(swallowAs("scope membership: session lookup", []))
    )?.some((s) => s.scopeId === fullScope) === true
  );
}

export type CanReadScope = (principalId: string, targetScope: ScopeId) => Promise<boolean>;
export type IsCurrentSharedScopeMember = (principalId: string, scope: ScopeId) => Promise<boolean>;

export function createIsCurrentSharedScopeMember(deps: ScopeMembershipDeps): IsCurrentSharedScopeMember {
  return async function isCurrentSharedScopeMember(principalId, scope) {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(scope);
    return (kind === "channel" || kind === "group") && currentSharedScopeMember(deps, kind, ref, principalId);
  };
}

export function withLiveTurnMembership(
  stored: IsCurrentSharedScopeMember | undefined,
  turn: { actorId: string; scopeId: ScopeId; verified: boolean },
): IsCurrentSharedScopeMember {
  return async (principalId, scope) =>
    (turn.verified && scope === turn.scopeId && samePerson(principalId, turn.actorId)) ||
    (await stored?.(principalId, scope)) === true;
}

export type CurrentScopeMembers = (scope: ScopeId) => Promise<Principal[] | undefined>;

export function createCurrentScopeMembers(deps: ScopeMembershipDeps, requireComplete = false): CurrentScopeMembers {
  const principal = (id: string, displayName?: string): Principal | null => {
    const classified = deps.identity?.classify(id);
    if (classified?.type !== undefined && classified.type !== "internal") return null;
    return {
      id,
      type: "internal",
      ...(classified?.teamIds ? { teamIds: [...classified.teamIds] } : {}),
      ...(displayName ? { displayName } : {}),
    };
  };

  return async function currentScopeMembers(scope): Promise<Principal[] | undefined> {
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "channel" && kind !== "group") return undefined;

    if (kind === "group" && deps.managedGroups?.recognizes(ref)) {
      const memberIds = await deps.managedGroups.members(ref);
      const members = (memberIds ?? []).map((id) => principal(id));
      if (requireComplete && (!memberIds?.length || members.some((member) => member === null))) return undefined;
      return members.filter((member): member is Principal => member !== null);
    }

    if (requireComplete) {
      const roster = await deps.directory?.conversationMembers?.(kind, ref);
      if (!roster?.length || roster.some((member) => member.type !== "internal")) return undefined;
      const members = roster.map((member) => principal(member.principalId, member.displayName));
      return members.some((member) => member === null) ? undefined : (members as Principal[]);
    }

    if (!deps.directory?.list) return undefined;
    if (kind === "channel" && (await deps.directory.channelPrivacy?.(ref)) !== true) return undefined;
    if (kind === "channel" && (await deps.directory.rosterCoversAudience?.(ref)) === false) return [];

    const candidates = await deps.directory.list();
    const membership = kind === "channel" ? deps.directory.channelMember : deps.directory.groupMember;
    const included = await Promise.all(
      candidates.map(async (member) =>
        (await membership.call(deps.directory, ref, member.principalId))
          ? principal(member.principalId, member.displayName)
          : null,
      ),
    );
    const present = included.filter((member): member is Principal => member !== null);
    if (kind === "group" && present.length === 0) return undefined;
    return present;
  };
}

export function createCanReadScope(deps: ScopeMembershipDeps): CanReadScope {
  return async function canReadScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind === "org") return deps.identity?.classify(principalId).type === "internal";
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "team") return teamMember(deps, principalId, ref);
    if (kind === "persona") return personaRoleAtLeast(deps, principalId, ref, "read");
    if (kind === "group") return memberOfSharedScope(deps, kind, ref, principalId, targetScope);
    if (kind === "channel") {
      if (await memberOfSharedScope(deps, kind, ref, principalId, targetScope)) return true;
      return (await channelPrivacy(deps, ref)) === false && activePrincipal(deps, principalId);
    }
    return false;
  };
}

export function createCanWriteScope(deps: ScopeMembershipDeps) {
  return async function canWriteScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind === "org") return true;
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "team") return teamMember(deps, principalId, ref);
    if (kind === "persona") return personaRoleAtLeast(deps, principalId, ref, "write");
    if (kind === "channel" || kind === "group") return currentSharedScopeMember(deps, kind, ref, principalId);
    return false;
  };
}

export type ScopeDelegationRequest = Pick<
  OrchestratorInput,
  "actor" | "conversation" | "surface" | "surfaceOrigin" | "botActor"
> & { origin?: OrchestratorInput["origin"] };

export function proactiveScopeDelegation(
  request: ScopeDelegationRequest,
  targetScope: ScopeId,
  externalSlackPolicies: ExternalSlackPolicies = {},
): boolean {
  const { actor, conversation, origin } = request;
  const source = request.surfaceOrigin;
  const ref = conversation.channelRef ?? conversation.threadRef;
  return (
    actor.id === `system:ambient:${orgId()}` &&
    origin?.kind === "automation" &&
    origin.ownerFire !== true &&
    !request.botActor &&
    (conversation.kind === "channel" || conversation.kind === "group") &&
    conversationScope(conversation, actor.id) === targetScope &&
    request.surface === "slack" &&
    source?.audience === "internal" &&
    source.author.surface === "slack" &&
    !!source.author.account &&
    !!source.author.id &&
    !!source.workspace &&
    !ref.startsWith("slack-account:") &&
    externalSlackRequestAllowed({ ...request, surface: request.surface }, externalSlackPolicies)
  );
}

export type CanManageScope = (principalId: string, scope: ScopeId) => Promise<boolean>;

export function createMembershipControlsScope(deps: ScopeMembershipDeps) {
  return async function membershipControlsScope(scope: ScopeId): Promise<boolean> {
    const { kind, ref } = parseScopeId(scope);
    if (kind === "group") return true;
    return kind === "channel" && (await channelPrivacy(deps, ref)) === true;
  };
}

export function createCanManageScope(deps: ScopeMembershipDeps): CanManageScope {
  return async function canManageScope(principalId: string, scope: ScopeId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(scope);
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "persona") return personaRoleAtLeast(deps, principalId, ref, "write");
    if (kind === "group") return currentSharedScopeMember(deps, kind, ref, principalId);
    if (kind === "channel")
      return (await channelPrivacy(deps, ref)) === true && currentSharedScopeMember(deps, kind, ref, principalId);
    return false;
  };
}

export type ManagesArtifactHome = (homeScopeId: ScopeId, createdBy: string, principalId: string) => Promise<boolean>;

export function createManagesArtifactHome(
  deps: ScopeMembershipDeps,
  canManageScope: CanManageScope,
): ManagesArtifactHome {
  return async function managesArtifactHome(homeScopeId, createdBy, principalId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    if (await canManageScope(principalId, homeScopeId)) return true;
    const { kind, ref } = parseScopeId(homeScopeId);
    if (kind === "team") return teamMember(deps, principalId, ref);
    if (!samePerson(createdBy, principalId)) return false;
    if (kind === "personal") return true;
    if (kind === "channel") return (await channelPrivacy(deps, ref)) === false;
    return false;
  };
}

export function rosterAdmits(roster: readonly string[], principalId: string, scope: ScopeId): boolean {
  return actsAsScope(principalId, scope) || roster.includes(principalId);
}

type ScopeMembershipSources = Omit<ScopeMembershipDeps, "directory" | "managedGroups" | "personas" | "teams"> & {
  directory: Pick<DirectoryStore, "getMany" | "channelMemberships" | "groupMemberships">;
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "members"> & {
    membersMany(groupIds: readonly string[]): Promise<Map<string, string[]>>;
  };
  personas?: { roles(principalId: string): Promise<Map<string, PersonaRole>> };
  teams?: { memberTeams(principalId: string, teamIds: readonly string[]): Promise<ReadonlySet<string>> };
};

export async function scopeMembershipSnapshot(
  sources: ScopeMembershipSources,
  principalId: string,
  scopes: readonly ScopeId[],
  people: readonly string[] = [],
) {
  const refs = (kind: "channel" | "group" | "team") => [
    ...new Set(
      scopes.flatMap((scope) => {
        const parsed = parseScopeId(scope);
        return parsed.kind === kind ? [parsed.ref] : [];
      }),
    ),
  ];
  const channels = refs("channel");
  const groups = refs("group");
  const teamIds = refs("team");
  const { directory, managedGroups, personas, teams } = sources;
  const members = await directory
    .getMany([...new Set([principalId, ...people].flatMap((id) => [id, canonicalPerson(id)]))])
    .catch(swallowAs("scope membership: directory lookup", new Map<string, DirectoryMember>()));
  const member = members.get(principalId);
  const aliases = [...new Set([principalId, member?.principalId, member?.slackId].filter((id): id is string => !!id))];
  const [channelFacts, groupFacts, projectMembers, roles, memberTeams] = await Promise.all([
    Promise.all(
      aliases.map(
        async (id) =>
          [
            id,
            await directory
              .channelMemberships(channels, id)
              .catch(swallowAs("scope membership: channel", new Map<string, ChannelMembershipFacts>())),
          ] as const,
      ),
    ),
    Promise.all(
      aliases.map(
        async (id) =>
          [
            id,
            await directory
              .groupMemberships(groups, id)
              .catch(swallowAs("scope membership: group", new Map<string, ScopeMembershipFacts>())),
          ] as const,
      ),
    ),
    managedGroups
      ?.membersMany(groups.filter((ref) => managedGroups.recognizes(ref)))
      .catch(swallowAs("scope membership: managed group", new Map<string, string[]>())),
    scopes.some((scope) => parseScopeId(scope).kind === "persona")
      ? personas?.roles(principalId).catch(swallowAs("scope membership: persona roles", new Map<string, PersonaRole>()))
      : undefined,
    teams
      ?.memberTeams(principalId, teamIds)
      .catch(swallowAs("scope membership: teams", new Set<string>() as ReadonlySet<string>)),
  ]);
  const channelsBy = new Map(channelFacts);
  const groupsBy = new Map(groupFacts);
  return {
    ...(sources.identity ? { identity: sources.identity } : {}),
    ...(teams
      ? {
          teams: {
            isMember: async (_tenant: Tenant, _id: string, teamId: string) => memberTeams?.has(teamId) === true,
          },
        }
      : {}),
    directory: {
      get: async (id: string) => members.get(id) ?? null,
      channelMember: async (ref: string, id: string) => channelsBy.get(id)?.get(ref)?.member === true,
      channelMembership: async (ref: string, id: string) => channelsBy.get(id)?.get(ref)?.membership,
      channelPrivacy: async (ref: string) => channelsBy.get(principalId)?.get(ref)?.isPrivate,
      groupMember: async (ref: string, id: string) => groupsBy.get(id)?.get(ref)?.member === true,
      groupMembership: async (ref: string, id: string) => groupsBy.get(id)?.get(ref)?.membership,
    },
    ...(managedGroups
      ? {
          managedGroups: {
            ...managedGroups,
            membership: async (ref: string, id: string) => projectMembers?.get(ref)?.includes(id),
          },
        }
      : {}),
    ...(personas ? { personas: { role: async (_id: string, persona: string) => roles?.get(persona) ?? null } } : {}),
  } satisfies ScopeMembershipDeps;
}
