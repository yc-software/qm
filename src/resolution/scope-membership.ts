import type { Principal, ScopeId } from "../types.ts";
import { atLeast, type PersonaRole } from "../personas/persona-schema.ts";
import { actsAsScope, parseScopeId, scopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { swallowAs } from "../util/errors.ts";

export interface ManagedGroupDirectory {
  recognizes(groupId: string): boolean;
  membership(groupId: string, principalId: string): Promise<boolean | undefined>;
  members(groupId: string): Promise<string[] | undefined>;
  version(groupId: string): Promise<string | undefined>;
  withVersion<T>(groupId: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  slackChannel?(groupId: string): Promise<{ channelId: string; channelName: string } | undefined>;
}

interface ScopeMembershipDeps {
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "membership" | "members">;
  directory?: {
    channelMember(channelId: string, principalId: string): Promise<boolean>;
    groupMember(groupId: string, principalId: string): Promise<boolean>;
    channelMembership(channelId: string, principalId: string): Promise<boolean | undefined>;
    groupMembership(groupId: string, principalId: string): Promise<boolean | undefined>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
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
  teams?: { isMember(principalId: string, teamId: string): Promise<boolean> };
  sessions?: { participantScopes(principalId: string): Promise<readonly { scopeId: ScopeId }[]> };
  personas?: { role(principalId: string, personaId: string): Promise<PersonaRole | null> };
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

type ScopeRole = "read" | "write" | "manage";

async function hasSharedScopeRole(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
  active: boolean,
  role: ScopeRole,
): Promise<boolean> {
  if (role === "read")
    return (
      (await memberOfSharedScope(deps, kind, ref, principalId, scopeId(kind, ref))) ||
      (kind === "channel" && active && (await channelPrivacy(deps, ref)) === false)
    );
  if (!active) return false;
  if (kind === "channel" && role === "manage" && (await channelPrivacy(deps, ref)) !== true) return false;
  return currentSharedScopeMember(deps, kind, ref, principalId);
}

function createRoleLookup(deps: ScopeMembershipDeps) {
  return async function hasRole(principalId: string, scope: ScopeId, role: ScopeRole): Promise<boolean> {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(scope);
    const active = activePrincipal(deps, principalId);
    switch (kind) {
      case "org":
        if (role === "manage") return false;
        return role === "read" ? deps.identity?.classify(principalId).type === "internal" : active;
      case "personal":
        return samePerson(ref, principalId) && (active || role === "read");
      case "team":
        return active && role !== "manage" && (await deps.teams?.isMember(principalId, ref)) === true;
      case "persona":
        return (
          (active || role === "read") &&
          atLeast(await deps.personas?.role(principalId, ref), role === "read" ? "read" : "write")
        );
      case "channel":
      case "group":
        return hasSharedScopeRole(deps, kind, ref, principalId, active, role);
      default:
        return false;
    }
  };
}

function roleCheck(deps: ScopeMembershipDeps, role: ScopeRole) {
  const hasRole = createRoleLookup(deps);
  return (principalId: string, scope: ScopeId): Promise<boolean> => hasRole(principalId, scope, role);
}

export const createCanReadScope = (deps: ScopeMembershipDeps): CanReadScope => roleCheck(deps, "read");
export const createCanWriteScope = (deps: ScopeMembershipDeps) => roleCheck(deps, "write");
export const createCanManageScope = (deps: ScopeMembershipDeps): CanManageScope => roleCheck(deps, "manage");

export type CanManageScope = (principalId: string, scope: ScopeId) => Promise<boolean>;

export function createMembershipControlsScope(deps: ScopeMembershipDeps) {
  return async function membershipControlsScope(scope: ScopeId): Promise<boolean> {
    const { kind, ref } = parseScopeId(scope);
    if (kind === "group") return true;
    return kind === "channel" && (await channelPrivacy(deps, ref)) === true;
  };
}

export type ManagesArtifactHome = (homeScopeId: ScopeId, createdBy: string, principalId: string) => Promise<boolean>;

export function createManagesArtifactHome(deps: ScopeMembershipDeps): ManagesArtifactHome {
  const hasRole = createRoleLookup(deps);
  return async function managesArtifactHome(homeScopeId, createdBy, principalId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(homeScopeId);
    if (await hasRole(principalId, homeScopeId, kind === "team" ? "write" : "manage")) return true;
    if (!samePerson(createdBy, principalId)) return false;
    return kind === "personal" || (kind === "channel" && (await channelPrivacy(deps, ref)) === false);
  };
}

export function rosterAdmits(roster: readonly string[], principalId: string, scope: ScopeId): boolean {
  return actsAsScope(principalId, scope) || roster.includes(principalId);
}
