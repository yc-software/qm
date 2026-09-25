import type { Grant, GrantedHandle, Principal, ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { parseRef, refPrefix } from "./resource-ref.ts";
import { samePerson } from "../directory/person.ts";
import type { ResourceKind } from "./resource-ref.ts";

const isFileGrant = (g: Grant) => parseRef(g.ref).kind === "file";

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

type ScopeEntitlement = (p: Principal, scope: ScopeId, sessionScopeId: ScopeId, orgScopeId: ScopeId) => boolean;

export type ScopeManagement = (principalId: string, scopeId: ScopeId, authoredBy?: string) => Promise<boolean>;

function toHandle(g: Grant): GrantedHandle {
  return {
    handlePath: `shared/${basename(g.ref)}`,
    ownerScopeId: g.ownerScopeId,
    ownerPath: g.ref,
    permission: g.permission,
  };
}

function ownerOf(scopeId: ScopeId): string | null {
  const { kind, ref } = parseScopeId(scopeId);
  return kind === "personal" ? ref : null;
}

function isMembershipManaged(scopeId: ScopeId): boolean {
  const { kind } = parseScopeId(scopeId);
  return kind === "channel" || kind === "group";
}

export interface AclStore {
  grant(g: Grant, authoredBy?: string): Promise<void>;
  revoke(
    ownerScopeId: ScopeId,
    ref: string,
    granteeScopeId: ScopeId,
    revokedBy: string,
    authoredBy?: string,
  ): Promise<void>;
  replaceGrantsIfCurrent(
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
    changedBy: string,
    authoredBy?: string,
  ): Promise<boolean>;
  handlesFor(scopeIds: readonly ScopeId[]): Promise<GrantedHandle[]>;
  handlesForAudience(
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<GrantedHandle[]>;
  grantsFor(ownerScopeId: ScopeId, ref: string): Promise<Grant[]>;
  grantsOfKind(
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  sharedOfKindForAudience(
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  list(): Promise<readonly Grant[]>;
}

export interface AclStoreOptions {
  manages?: ScopeManagement;
}

export interface GrantPersistence {
  all(): Promise<Grant[]>;
  put(g: Grant): Promise<void>;
  remove(g: Grant): Promise<void>;
  replaceForResourceIfCurrent(
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
  ): Promise<boolean>;
}

function sameGrant(a: Grant, b: Grant): boolean {
  return (
    a.ownerScopeId === b.ownerScopeId &&
    a.ref === b.ref &&
    a.granteeScopeId === b.granteeScopeId &&
    a.permission === b.permission
  );
}

function sameGrantTuple(a: Grant, b: Grant): boolean {
  return sameGrant(a, b) && a.grantedBy === b.grantedBy;
}

function sameGrantSet(a: readonly Grant[], b: readonly Grant[]): boolean {
  return a.length === b.length && a.every((grant) => b.some((candidate) => sameGrantTuple(grant, candidate)));
}

function createMemoryGrantPersistence(): GrantPersistence {
  const grants: Grant[] = [];
  return {
    async all() {
      const key = (g: Grant) => `${g.ownerScopeId}\n${g.ref}\n${g.granteeScopeId}\n${g.permission}`;
      return grants.slice().sort((a, b) => {
        if (key(a) < key(b)) return -1;
        if (key(a) > key(b)) return 1;
        return 0;
      });
    },
    async put(g) {
      if (!grants.some((x) => sameGrant(x, g))) grants.push(g);
    },
    async remove(g) {
      for (let i = grants.length - 1; i >= 0; i--) {
        if (sameGrant(grants[i]!, g)) grants.splice(i, 1);
      }
    },
    async replaceForResourceIfCurrent(ownerScopeId, ref, expected, replacement) {
      const current = grants.filter((grant) => grant.ownerScopeId === ownerScopeId && grant.ref === ref);
      if (!sameGrantSet(current, expected)) return false;
      for (let i = grants.length - 1; i >= 0; i--) {
        if (grants[i]!.ownerScopeId === ownerScopeId && grants[i]!.ref === ref) grants.splice(i, 1);
      }
      grants.push(...replacement);
      return true;
    },
  };
}

export function createAclStore(
  persist: GrantPersistence = createMemoryGrantPersistence(),
  opts: AclStoreOptions = {},
): AclStore {
  async function canManage(scopeId: ScopeId, principalId: string, authoredBy?: string): Promise<boolean> {
    const owner = ownerOf(scopeId);
    if (owner !== null) return samePerson(principalId, owner);
    if (isMembershipManaged(scopeId) && opts.manages) return opts.manages(principalId, scopeId, authoredBy);
    return true;
  }
  return {
    async grant(g, authoredBy) {
      if (!(await canManage(g.ownerScopeId, g.grantedBy, authoredBy))) {
        throw new Error("only a manager of this scope may grant access (no transitive re-share)");
      }
      await persist.put(g);
    },
    async revoke(ownerScopeId, ref, granteeScopeId, revokedBy, authoredBy) {
      if (!(await canManage(ownerScopeId, revokedBy, authoredBy))) {
        throw new Error("only a manager of this scope may revoke access");
      }
      const matches = (await persist.all()).filter(
        (g) => g.ownerScopeId === ownerScopeId && g.ref === ref && g.granteeScopeId === granteeScopeId,
      );
      for (const g of matches) await persist.remove(g);
    },
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (!(await canManage(ownerScopeId, changedBy, authoredBy))) {
        throw new Error("only a manager of this scope may replace access grants");
      }
      if (
        expected.some((grant) => grant.ownerScopeId !== ownerScopeId || grant.ref !== ref) ||
        replacement.some((grant) => grant.ownerScopeId !== ownerScopeId || grant.ref !== ref)
      ) {
        throw new Error("replacement grants must belong to the selected resource");
      }
      return persist.replaceForResourceIfCurrent(ownerScopeId, ref, expected, replacement);
    },
    async handlesFor(scopeIds) {
      const set = new Set(scopeIds);
      return (await persist.all()).filter((g) => isFileGrant(g) && set.has(g.granteeScopeId)).map(toHandle);
    },
    async handlesForAudience(audience, sessionScopeId, orgScopeId, entitled) {
      if (audience.length === 0) return [];
      const reaches = (p: Principal, g: Grant) =>
        entitled(p, g.granteeScopeId, sessionScopeId, orgScopeId) ||
        entitled(p, g.ownerScopeId, sessionScopeId, orgScopeId);
      return (await persist.all())
        .filter(
          (g) =>
            isFileGrant(g) &&
            audience.some((p) => entitled(p, g.granteeScopeId, sessionScopeId, orgScopeId)) &&
            audience.every((p) => reaches(p, g)),
        )
        .map(toHandle);
    },
    async grantsFor(ownerScopeId, ref) {
      return (await persist.all()).filter((g) => g.ownerScopeId === ownerScopeId && g.ref === ref);
    },
    async grantsOfKind(kind, audience, sessionScopeId, orgScopeId, entitled) {
      if (audience.length === 0) return [];
      const prefix = refPrefix(kind);
      return (await persist.all()).filter(
        (g) =>
          g.ref.startsWith(prefix) &&
          g.ownerScopeId === orgScopeId &&
          audience.every((p) => entitled(p, g.granteeScopeId, sessionScopeId, orgScopeId)),
      );
    },
    async sharedOfKindForAudience(kind, audience, sessionScopeId, orgScopeId, entitled) {
      if (audience.length === 0) return [];
      const prefix = refPrefix(kind);
      const reaches = (p: Principal, g: Grant) =>
        entitled(p, g.granteeScopeId, sessionScopeId, orgScopeId) ||
        entitled(p, g.ownerScopeId, sessionScopeId, orgScopeId);
      return (await persist.all()).filter(
        (g) =>
          g.ref.startsWith(prefix) &&
          audience.some((p) => entitled(p, g.granteeScopeId, sessionScopeId, orgScopeId)) &&
          audience.every((p) => reaches(p, g)),
      );
    },
    list: () => persist.all(),
  };
}
