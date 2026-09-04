import { orgId as configOrgId } from "../config.ts";
import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import type { AdminGrant, AdminGrantStore, AdminRole } from "./admin-grant-store.ts";
import { personKey, samePerson } from "../directory/person.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "./admin-grant-store.ts";

export type { AdminGrant } from "./admin-grant-store.ts";

export interface AdminStatus {
  isAdmin: boolean;
  role?: AdminRole;
  scopeId?: ScopeId;
}

export class AdminError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminError";
    this.status = status;
  }
}

export function adminStatusFromGrants(grants: readonly AdminGrant[], principalId: string): AdminStatus {
  for (const g of grants) {
    if (!samePerson(g.principalId, principalId)) continue;
    if (g.role === "org_admin") return { isAdmin: true, role: "org_admin", scopeId: g.scopeId };
  }
  return { isAdmin: false };
}

export interface AdminService {
  resolveActor(header: string | undefined): Principal | null;
  canAdminister(principal: Principal, target: ScopeId): Promise<boolean>;
  adminStatusOf(principal: Principal): Promise<AdminStatus>;
  listGrants(): Promise<AdminGrant[]>;
  createGrant(actor: Principal, input: { principalId: string; role: AdminRole; scopeId: ScopeId }): Promise<AdminGrant>;
  revokeGrant(actor: Principal, principalId: string, scope: ScopeId, role: AdminRole): Promise<void>;
}

export function parseAdminGrants(raw: string | undefined, orgId: string): AdminGrant[] | undefined {
  if (raw === undefined) return undefined;
  const grants: AdminGrant[] = [];
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const separator = entry.lastIndexOf(":");
    const principalId = entry.slice(0, separator).trim();
    const role = entry.slice(separator + 1).trim();
    if (!principalId || role !== "org_admin") continue;
    grants.push({ principalId, scopeId: scopeId("org", orgId), role });
  }
  return grants;
}

function defaultAdminGrants(orgId: string): AdminGrant[] {
  return [
    { principalId: "admin-alice", scopeId: scopeId("org", orgId), role: "org_admin" },
    { principalId: "admin-bob", scopeId: scopeId("org", orgId), role: "org_admin" },
  ];
}

export function bootAdminGrantSeed(rawAdminGrants: string | undefined, orgId: string, durable: boolean): AdminGrant[] {
  return parseAdminGrants(rawAdminGrants, orgId) ?? (durable ? [] : defaultAdminGrants(orgId));
}

export interface AdminServiceOptions {
  now?: () => number;
}

export function createAdminService(store?: AdminGrantStore, opts: AdminServiceOptions = {}): AdminService {
  const orgId = configOrgId();
  const grants: AdminGrantStore =
    store ?? createAdminGrantStore(createMemoryAdminGrantPersistence(), { seed: defaultAdminGrants(orgId) });
  const now = opts.now ?? (() => Date.now());

  async function isOrgAdmin(actor: Principal): Promise<boolean> {
    return adminStatusFromGrants(await grants.list(), actor.id).role === "org_admin";
  }

  return {
    resolveActor(header) {
      if (!header) return null;
      const at = header.lastIndexOf("@");
      if (at <= 0 || at === header.length - 1) return null;
      const id = header.slice(0, at);
      const org = header.slice(at + 1);
      if (org !== orgId) return null;
      return { id, type: "internal" };
    },
    async canAdminister(principal, _target) {
      return isOrgAdmin(principal);
    },
    async adminStatusOf(principal) {
      return adminStatusFromGrants(await grants.list(), principal.id);
    },
    listGrants() {
      return grants.list();
    },
    async createGrant(actor, input) {
      if (!(await isOrgAdmin(actor))) throw new AdminError(403, "only an org admin may grant admin roles");
      const principalId = input.principalId?.trim();
      if (!principalId) throw new AdminError(400, "principalId required");
      const { role } = input;
      if (role !== "org_admin") {
        throw new AdminError(400, "role must be org_admin");
      }
      const parsed = parseScopeId(input.scopeId);
      if (parsed.kind !== "org" || parsed.ref !== orgId) {
        throw new AdminError(400, `org_admin scope must be org:${orgId}`);
      }
      const grant: AdminGrant = { principalId, scopeId: input.scopeId, role, grantedBy: actor.id, createdAt: now() };
      await grants.add(grant);
      return grant;
    },
    async revokeGrant(actor, principalId, scope, role) {
      const list = await grants.list();
      if (adminStatusFromGrants(list, actor.id).role !== "org_admin") {
        throw new AdminError(403, "only an org admin may revoke admin roles");
      }
      const matched = list.filter(
        (g) => samePerson(g.principalId, principalId) && g.scopeId === scope && g.role === role,
      );
      if (role === "org_admin") {
        const distinctOrgAdmins = new Set(
          list.filter((g) => g.role === "org_admin").map((g) => personKey(g.principalId)),
        );
        if (matched.length > 0 && distinctOrgAdmins.size <= 1) {
          throw new AdminError(400, "cannot revoke the last org admin");
        }
      }
      for (const g of matched) await grants.revoke(g.principalId, scope, role);
    },
  };
}
