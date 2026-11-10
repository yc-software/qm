import { createHash } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import type { AdminGrant, AdminGrantStore, AdminRole } from "./admin-grant-store.ts";
import { personKey, samePerson } from "../directory/person.ts";
import type { UserStore } from "../identity/user-store.ts";
import type { Tenant } from "../tenants/context.ts";
import { bootTenant } from "../tenants/boot.ts";

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
  users: UserStore;
  resolveActor(header: string | undefined): Principal | null;
  canAdminister(tenant: Tenant, principal: Principal, target: ScopeId): Promise<boolean>;
  adminStatusOf(tenant: Tenant, principal: Principal): Promise<AdminStatus>;
  listGrants(tenant: Tenant): Promise<AdminGrant[]>;
  provisionTrustedEntry(
    tenant: Tenant,
    issuer: string,
    subject: string,
  ): Promise<{ grant: AdminGrant; created: boolean }>;
  createGrant(
    tenant: Tenant,
    actor: Principal,
    input: { principalId: string; role: AdminRole; scopeId: ScopeId },
  ): Promise<AdminGrant>;
  revokeGrant(tenant: Tenant, actor: Principal, principalId: string, scope: ScopeId, role: AdminRole): Promise<void>;
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

export interface AdminServiceOptions {
  now?: () => number;
  trustedOidcAdminIssuer?: string;
  /** Tenants the principal may sign in to. Trusted entry grants admin only in one of these or the boot tenant. */
  memberTenants?: (principalId: string) => Promise<readonly string[]>;
  users: UserStore;
}

export function createAdminService(grants: AdminGrantStore, opts: AdminServiceOptions): AdminService {
  const orgId = configOrgId();
  const now = opts.now ?? (() => Date.now());

  async function isOrgAdmin(tenant: Tenant, actor: Principal): Promise<boolean> {
    return adminStatusFromGrants(await grants.list(tenant), actor.id).role === "org_admin";
  }

  return {
    users: opts.users,
    resolveActor(header) {
      if (!header) return null;
      const at = header.lastIndexOf("@");
      if (at <= 0 || at === header.length - 1) return null;
      const id = header.slice(0, at);
      const org = header.slice(at + 1);
      if (org !== orgId) return null;
      return { id, type: "internal" };
    },
    async canAdminister(tenant, principal, _target) {
      return isOrgAdmin(tenant, principal);
    },
    async adminStatusOf(tenant, principal) {
      return adminStatusFromGrants(await grants.list(tenant), principal.id);
    },
    async provisionTrustedEntry(tenant, issuer, subject) {
      if (!opts.trustedOidcAdminIssuer || issuer !== opts.trustedOidcAdminIssuer)
        throw new AdminError(403, "trusted administrator provisioning is not enabled for this issuer");
      if (!subject || subject.length > 255 || Buffer.from(subject).toString("utf8") !== subject)
        throw new AdminError(400, "invalid trusted subject");
      const principalId = `oidc:${createHash("sha256").update(issuer).digest("hex")}:${Buffer.from(subject).toString("base64url")}`;
      if (tenant.id !== bootTenant() && !(await opts.memberTenants?.(principalId))?.includes(tenant.id))
        throw new AdminError(403, "trusted subject is not a member of this tenant");
      const existing = (await grants.list(tenant)).find((g) => g.principalId === principalId && g.role === "org_admin");
      if (existing) return { grant: existing, created: false };
      const grant: AdminGrant = {
        principalId,
        role: "org_admin",
        scopeId: scopeId("org", orgId),
        grantedBy: `trusted-oidc:${issuer}`,
        createdAt: now(),
      };
      await opts.users.record({ id: principalId, source: "admin", at: grant.createdAt ?? Date.now() });
      const created = await grants.addIfAbsent(tenant, grant);
      return { grant, created };
    },
    async listGrants(tenant) {
      return grants.list(tenant);
    },
    async createGrant(tenant, actor, input) {
      if (!(await isOrgAdmin(tenant, actor))) throw new AdminError(403, "only an org admin may grant admin roles");
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
      await opts.users.record({ id: principalId, source: "admin", at: grant.createdAt ?? Date.now() });
      await grants.add(tenant, grant);
      return grant;
    },
    async revokeGrant(tenant, actor, principalId, scope, role) {
      const list = await grants.list(tenant);
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
      for (const g of matched) await grants.revoke(tenant, g.principalId, scope, role);
    },
  };
}
