import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";

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
    channelMembership?(channelId: string, principalId: string): Promise<boolean | undefined>;
    groupMembership?(groupId: string, principalId: string): Promise<boolean | undefined>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
    list?(): Promise<Array<{ principalId: string; displayName?: string }>>;
    get?(principalId: string): Promise<{ principalId?: string; slackId?: string } | null>;
    conversationRosterKnown?(kind: "channel" | "group", id: string): Promise<boolean>;
  };
  identity?: {
    classify(externalId: string, isExternalGuest?: boolean): { type?: string; teamIds?: readonly string[] };
  };
  sessions?: { listByParticipant(principalId: string): Promise<readonly { scopeId: ScopeId }[]> };
}

function activePrincipal(deps: ScopeMembershipDeps, principalId: string): boolean {
  const type = deps.identity?.classify(principalId).type;
  return type === undefined || type === "internal";
}

async function currentSharedScopeMember(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean> {
  if (!activePrincipal(deps, principalId)) return false;
  const member = await deps.directory?.get?.(principalId).catch(() => null);
  const ids = [...new Set([principalId, member?.principalId, member?.slackId].filter((id): id is string => !!id))];
  if (kind === "group" && deps.managedGroups?.recognizes(ref)) {
    for (const id of ids) if ((await deps.managedGroups.membership(ref, id).catch(() => false)) === true) return true;
    return false;
  }
  const direct = kind === "channel" ? deps.directory?.channelMember : deps.directory?.groupMember;
  for (const id of ids) if ((await direct?.call(deps.directory, ref, id).catch(() => false)) === true) return true;
  return false;
}

async function sharedScopeMembership(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean | undefined> {
  if (!activePrincipal(deps, principalId)) return false;
  if (kind === "group" && deps.managedGroups?.recognizes(ref)) {
    return (await deps.managedGroups.membership(ref, principalId).catch(() => false)) === true;
  }
  const triState = kind === "channel" ? deps.directory?.channelMembership : deps.directory?.groupMembership;
  if (triState) return triState.call(deps.directory, ref, principalId).catch(() => undefined);
  const direct = kind === "channel" ? deps.directory?.channelMember : deps.directory?.groupMember;
  const member = await direct?.call(deps.directory, ref, principalId).catch(() => false);
  if (member === true) return true;
  if (kind === "channel" && (await deps.directory?.channelPrivacy?.(ref).catch(() => undefined)) !== undefined)
    return false;
  return undefined;
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
    (await deps.sessions?.listByParticipant(principalId).catch(() => []))?.some((s) => s.scopeId === fullScope) === true
  );
}

export type CanReadScope = (principalId: string, targetScope: ScopeId) => Promise<boolean>;
export type CanWriteScope = (principalId: string, targetScope: ScopeId) => Promise<boolean>;
/**
 * The roster the transport verified for the current turn: the speaker plus the
 * room's members as the Slack plugin fetched them from Slack moments ago. Only
 * consulted when the directory store has no roster of its own for the room.
 */
export interface LiveRoster {
  actorId: string;
  members: ReadonlyArray<{ id: string; type?: string }>;
}

export type IsCurrentSharedScopeMember = (principalId: string, scope: ScopeId, live?: LiveRoster) => Promise<boolean>;

export function createIsCurrentSharedScopeMember(deps: ScopeMembershipDeps): IsCurrentSharedScopeMember {
  return async function isCurrentSharedScopeMember(principalId, scope, live) {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "channel" && kind !== "group") return false;
    if (await currentSharedScopeMember(deps, kind, ref, principalId)) return true;
    return liveRosterCoversStoreLag(deps, kind, ref, principalId, live);
  };
}

/**
 * The directory store learns about a room from the Slack plugin's background
 * directory sync. On the first message in a brand-new group DM (or a channel
 * the bot was just added to) the store has no roster for the room yet, so the
 * stored check says "not a member" and Open sharing silently degrades for that
 * one turn: no carried memory, no live-speaker keychain. The plugin fetched the
 * room's roster from Slack for this very turn and verified the speaker is in
 * it, so while the store holds no roster for the room, that roster stands in.
 *
 * Narrow on purpose: only the speaker, only a complete all-internal roster,
 * never for managed groups, and never once the store holds a roster for the
 * room (a stored roster that excludes the speaker is a revocation and wins).
 */
async function liveRosterCoversStoreLag(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
  live: LiveRoster | undefined,
): Promise<boolean> {
  if (!live || !samePerson(principalId, live.actorId)) return false;
  if (!activePrincipal(deps, principalId)) return false;
  if (!live.members.length || !live.members.every((m) => m.type === "internal")) return false;
  if (!live.members.some((m) => samePerson(m.id, principalId))) return false;
  if (kind === "group" && deps.managedGroups?.recognizes(ref)) return false;
  const rosterKnown = deps.directory?.conversationRosterKnown;
  if (!rosterKnown) return false;
  try {
    return (await rosterKnown.call(deps.directory, kind, ref)) === false;
  } catch {
    return false;
  }
}

/** Forward the turn's verified roster only for lookups about the turn's own scope. */
export function withLiveRoster(
  stored: IsCurrentSharedScopeMember | undefined,
  turn: { scopeId: ScopeId; roster: LiveRoster | undefined },
): IsCurrentSharedScopeMember {
  return async (principalId, scope, live) =>
    (await stored?.(principalId, scope, live ?? (scope === turn.scopeId ? turn.roster : undefined))) === true;
}

export type CurrentScopeMembers = (scope: ScopeId) => Promise<Principal[] | undefined>;

export function createCurrentScopeMembers(deps: ScopeMembershipDeps): CurrentScopeMembers {
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
      return (memberIds ?? []).map((id) => principal(id)).filter((member): member is Principal => member !== null);
    }

    if (!deps.directory?.list) return undefined;
    if (kind === "channel" && (await deps.directory.channelPrivacy?.(ref)) !== true) return undefined;

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
    if (kind === "team") {
      return deps.identity?.classify(principalId).teamIds?.includes(ref) === true;
    }
    if (kind === "group") return memberOfSharedScope(deps, kind, ref, principalId, targetScope);
    if (kind === "channel") {
      if (await memberOfSharedScope(deps, kind, ref, principalId, targetScope)) return true;
      const isPrivate = await deps.directory?.channelPrivacy?.(ref).catch(() => undefined);
      if (isPrivate === false) return activePrincipal(deps, principalId);
      return false;
    }
    return false;
  };
}

export function createCanWriteScope(deps: ScopeMembershipDeps): CanWriteScope {
  return async function canWriteScope(principalId, targetScope) {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind === "org") return true;
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "team") return deps.identity?.classify(principalId).teamIds?.includes(ref) === true;
    if (kind === "channel" || kind === "group") return currentSharedScopeMember(deps, kind, ref, principalId);
    return false;
  };
}

export type CanManageScope = (principalId: string, scope: ScopeId) => Promise<boolean>;
export type MembershipControlsScope = (scope: ScopeId) => Promise<boolean>;

export function createMembershipControlsScope(deps: ScopeMembershipDeps): MembershipControlsScope {
  return async function membershipControlsScope(scope) {
    const { kind, ref } = parseScopeId(scope);
    if (kind === "group") return true;
    return kind === "channel" && (await deps.directory?.channelPrivacy?.(ref).catch(() => undefined)) === true;
  };
}

export function createCanManageScope(deps: ScopeMembershipDeps): CanManageScope {
  return async function canManageScope(principalId: string, scope: ScopeId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(scope);
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "group") return currentSharedScopeMember(deps, kind, ref, principalId);
    if (kind === "channel") {
      const isPrivate = await deps.directory?.channelPrivacy?.(ref).catch(() => undefined);
      if (isPrivate !== true) return false;
      return currentSharedScopeMember(deps, kind, ref, principalId);
    }
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
    if (!samePerson(createdBy, principalId)) return false;
    if (kind === "personal") return true;
    if (kind === "channel") return (await deps.directory?.channelPrivacy?.(ref).catch(() => undefined)) === false;
    return false;
  };
}
