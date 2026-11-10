import type { Grant, GrantedHandle, Principal, ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { parseRef } from "./resource-ref.ts";
import { samePerson } from "../directory/person.ts";
import type { ResourceKind } from "./resource-ref.ts";
import type { FileArtifact, FileArtifactRef } from "../files/file-artifact-store.ts";
import type { Tenant } from "../tenants/context.ts";

const isFileGrant = (g: Grant) => parseRef(g.ref).kind === "file";

type ScopeEntitlement = (p: Principal, sessionScopeId: ScopeId, orgScopeId: ScopeId) => readonly ScopeId[];

function audienceScopes(
  audience: readonly Principal[],
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
  entitled: ScopeEntitlement,
): Set<ScopeId>[] {
  return audience.map((p) => new Set(entitled(p, sessionScopeId, orgScopeId)));
}

const union = (sets: readonly Set<ScopeId>[]): ScopeId[] => [...new Set(sets.flatMap((s) => [...s]))];

function audienceReaches(scopes: readonly Set<ScopeId>[]): (g: Grant) => boolean {
  return (g) =>
    scopes.some((s) => s.has(g.granteeScopeId)) &&
    scopes.every((s) => s.has(g.granteeScopeId) || s.has(g.ownerScopeId));
}

export type ScopeManagement = (principalId: string, scopeId: ScopeId, authoredBy?: string) => Promise<boolean>;

function ownerOf(scopeId: ScopeId): string | null {
  const { kind, ref } = parseScopeId(scopeId);
  return kind === "personal" ? ref : null;
}

function isMembershipManaged(scopeId: ScopeId): boolean {
  const { kind } = parseScopeId(scopeId);
  return kind === "channel" || kind === "group";
}

export interface AclStore {
  grant(tenant: Tenant, g: Grant, authoredBy?: string): Promise<void>;
  revoke(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    granteeScopeId: ScopeId,
    revokedBy: string,
    authoredBy?: string,
  ): Promise<void>;
  replaceGrantsIfCurrent(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
    changedBy: string,
    authoredBy?: string,
  ): Promise<boolean>;
  handlesFor(tenant: Tenant, scopeIds: readonly ScopeId[]): Promise<GrantedHandle[]>;
  handlesForAudience(
    tenant: Tenant,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<GrantedHandle[]>;
  grantsFor(tenant: Tenant, ownerScopeId: ScopeId, ref: string): Promise<Grant[]>;
  grantsOfKind(
    tenant: Tenant,
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  sharedOfKindForAudience(
    tenant: Tenant,
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  find(tenant: Tenant, query: GrantQuery): Promise<Grant[]>;
}

type GrantQuery = {
  ownerScopeId?: ScopeId;
  ref?: string;
  kind?: Exclude<ResourceKind, "file">;
  granteeScopeIds?: readonly ScopeId[];
} & ({ ownerScopeId: ScopeId } | { granteeScopeIds: readonly ScopeId[] });

export interface AclStoreOptions {
  manages?: ScopeManagement;
  resolveFiles?: (refs: readonly FileArtifactRef[]) => Promise<FileArtifact[]>;
}

export interface GrantPersistence {
  find(tenant: Tenant, query: GrantQuery): Promise<Grant[]>;
  put(tenant: Tenant, g: Grant): Promise<void>;
  remove(tenant: Tenant, g: Grant): Promise<void>;
  replaceForResourceIfCurrent(
    tenant: Tenant,
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

export function sameGrantSet(a: readonly Grant[], b: readonly Grant[]): boolean {
  return a.length === b.length && a.every((grant) => b.some((candidate) => sameGrantTuple(grant, candidate)));
}

export function createAclStore(persist: GrantPersistence, opts: AclStoreOptions = {}): AclStore {
  async function resolveGrantedFiles(grants: readonly Grant[]): Promise<Map<string, FileArtifact>> {
    const refs = grants.filter(isFileGrant).map((g) => ({ id: g.ref, ownerScopeId: g.ownerScopeId }));
    const files = refs.length ? await opts.resolveFiles?.(refs) : [];
    return new Map(files?.filter((file) => file.enabled).map((file) => [file.id, file]));
  }

  async function validateFileGrant(g: Grant): Promise<void> {
    if (!isFileGrant(g)) return;
    const file = (await resolveGrantedFiles([g])).get(g.ref);
    if (!file || file.ownerScopeId !== g.ownerScopeId) {
      throw new Error(
        "file grants require an enabled Files record ID owned by the granting scope; put the file in Files first using POST /v1/files/uploads, then share its ID",
      );
    }
  }

  async function handles(grants: Grant[]): Promise<GrantedHandle[]> {
    const files = await resolveGrantedFiles(grants);
    const result: GrantedHandle[] = [];
    for (const grant of grants) {
      const file = files.get(grant.ref);
      if (file && file.ownerScopeId === grant.ownerScopeId) {
        result.push({
          handlePath: `shared/${file.name}`,
          ownerScopeId: file.ownerScopeId,
          fileId: file.id,
          permission: grant.permission,
        });
      }
    }
    return result;
  }

  async function canManage(scopeId: ScopeId, principalId: string, authoredBy?: string): Promise<boolean> {
    const owner = ownerOf(scopeId);
    if (owner !== null) return samePerson(principalId, owner);
    if (isMembershipManaged(scopeId) && opts.manages) return opts.manages(principalId, scopeId, authoredBy);
    return true;
  }
  return {
    async grant(tenant, g, authoredBy) {
      if (!(await canManage(g.ownerScopeId, g.grantedBy, authoredBy))) {
        throw new Error("only a manager of this scope may grant access (no transitive re-share)");
      }
      await validateFileGrant(g);
      await persist.put(tenant, g);
    },
    async revoke(tenant, ownerScopeId, ref, granteeScopeId, revokedBy, authoredBy) {
      if (!(await canManage(ownerScopeId, revokedBy, authoredBy))) {
        throw new Error("only a manager of this scope may revoke access");
      }
      const matches = await persist.find(tenant, { ownerScopeId, ref, granteeScopeIds: [granteeScopeId] });
      for (const g of matches) await persist.remove(tenant, g);
    },
    async replaceGrantsIfCurrent(tenant, ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (!(await canManage(ownerScopeId, changedBy, authoredBy))) {
        throw new Error("only a manager of this scope may replace access grants");
      }
      if (
        expected.some((grant) => grant.ownerScopeId !== ownerScopeId || grant.ref !== ref) ||
        replacement.some((grant) => grant.ownerScopeId !== ownerScopeId || grant.ref !== ref)
      ) {
        throw new Error("replacement grants must belong to the selected resource");
      }
      for (const grant of replacement) await validateFileGrant(grant);
      return persist.replaceForResourceIfCurrent(tenant, ownerScopeId, ref, expected, replacement);
    },
    async handlesFor(tenant, scopeIds) {
      return handles((await persist.find(tenant, { granteeScopeIds: scopeIds })).filter(isFileGrant));
    },
    async handlesForAudience(tenant, audience, sessionScopeId, orgScopeId, entitled) {
      if (audience.length === 0) return [];
      const scopes = audienceScopes(audience, sessionScopeId, orgScopeId, entitled);
      const reaches = audienceReaches(scopes);
      return handles(
        (await persist.find(tenant, { granteeScopeIds: union(scopes) })).filter((g) => isFileGrant(g) && reaches(g)),
      );
    },
    grantsFor: (tenant, ownerScopeId, ref) => persist.find(tenant, { ownerScopeId, ref }),
    async grantsOfKind(tenant, kind, audience, sessionScopeId, orgScopeId, entitled) {
      if (audience.length === 0) return [];
      const scopes = audienceScopes(audience, sessionScopeId, orgScopeId, entitled);
      return (await persist.find(tenant, { ownerScopeId: orgScopeId, kind, granteeScopeIds: union(scopes) })).filter(
        (g) => scopes.every((s) => s.has(g.granteeScopeId)),
      );
    },
    async sharedOfKindForAudience(tenant, kind, audience, sessionScopeId, orgScopeId, entitled) {
      if (audience.length === 0) return [];
      const scopes = audienceScopes(audience, sessionScopeId, orgScopeId, entitled);
      return (await persist.find(tenant, { kind, granteeScopeIds: union(scopes) })).filter(audienceReaches(scopes));
    },
    find: (tenant, query) => persist.find(tenant, query),
  };
}
