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
  if (kind === "group" && deps.managedGroups?.recognizes(ref)) {
    return (await deps.managedGroups.membership(ref, principalId).catch(() => false)) === true;
  }
  const direct = kind === "channel" ? deps.directory?.channelMember : deps.directory?.groupMember;
  return (await direct?.call(deps.directory, ref, principalId).catch(() => false)) === true;
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
export type IsCurrentSharedScopeMember = (principalId: string, scope: ScopeId) => Promise<boolean>;

export function createIsCurrentSharedScopeMember(deps: ScopeMembershipDeps): IsCurrentSharedScopeMember {
  return async function isCurrentSharedScopeMember(principalId, scope) {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(scope);
    return (kind === "channel" || kind === "group") && currentSharedScopeMember(deps, kind, ref, principalId);
  };
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
