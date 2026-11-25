import { createHash } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { isAdminRole, type AdminGrant, type AdminGrantStore, type AdminRole } from "./admin-grant-store.ts";
import { personKey, samePerson } from "../directory/person.ts";
import type { UserStore } from "../identity/user-store.ts";
import type { Tenant } from "../tenants/context.ts";
import { bootTenant } from "../tenants/boot.ts";
import { PrincipalLinkError } from "../identity/principal-links.ts";

export type { AdminGrant } from "./admin-grant-store.ts";

export interface AdminStatus {
  isAdmin: boolean;
  role?: AdminRole;
  scopeId?: ScopeId;
}

export class AdminError extends Error {
  status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdminError";
    this.status = status;
  }
}

export function adminStatusFromGrants(grants: readonly AdminGrant[], principalId: string): AdminStatus {
  let ownerGrant: AdminGrant | undefined;
  for (const g of grants) {
    if (!samePerson(g.principalId, principalId)) continue;
    if (g.role === "org_admin") return { isAdmin: true, role: "org_admin", scopeId: g.scopeId };
    if (g.role === "owner" && !ownerGrant) ownerGrant = g;
  }
  if (ownerGrant) return { isAdmin: true, role: "owner", scopeId: ownerGrant.scopeId };
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
  provisionSelfServe(
    tenant: Tenant,
    issuer: string,
    subject: string,
    email: string | null,
  ): Promise<{ grant: AdminGrant; granted: boolean }>;
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
    if (!principalId || !isAdminRole(role)) continue;
    grants.push({ principalId, scopeId: scopeId("org", orgId), role });
  }
  return grants;
}

export interface AdminServiceOptions {
  now?: () => number;
  trustedOidcAdminIssuer?: string;
  trustedOidcAdminRole?: AdminRole;
  memberTenants?: (principalId: string) => Promise<readonly string[]>;
  users: UserStore;
}

export function trustedSubjectPrincipal(issuer: string, subject: string): string {
  if (!subject || subject.length > 255 || Buffer.from(subject).toString("utf8") !== subject)
    throw new AdminError(400, "invalid trusted subject");
  return `oidc:${createHash("sha256").update(issuer).digest("hex")}:${Buffer.from(subject).toString("base64url")}`;
}

export function createAdminService(grants: AdminGrantStore, opts: AdminServiceOptions): AdminService {
  const orgId = configOrgId();
  const now = opts.now ?? (() => Date.now());
  const trustedRole: AdminRole = opts.trustedOidcAdminRole ?? "org_admin";

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
    async canAdminister(tenant, principal, target) {
      const status = adminStatusFromGrants(await grants.list(tenant), principal.id);
      if (status.role === "org_admin") return true;
      if (status.role === "owner") return parseScopeId(target).kind === "org";
      return false;
    },
    async adminStatusOf(tenant, principal) {
      return adminStatusFromGrants(await grants.list(tenant), principal.id);
    },
    async provisionTrustedEntry(tenant, issuer, subject) {
      if (!opts.trustedOidcAdminIssuer || issuer !== opts.trustedOidcAdminIssuer)
        throw new AdminError(403, "trusted administrator provisioning is not enabled for this issuer");
      const principalId = trustedSubjectPrincipal(issuer, subject);
      if (tenant.id !== bootTenant() && !(await opts.memberTenants?.(principalId))?.includes(tenant.id))
        throw new AdminError(403, "trusted subject is not a member of this tenant");
      const existing = (await grants.list(tenant)).find(
        (g) => g.principalId === principalId && (g.role === trustedRole || g.role === "org_admin"),
      );
      if (existing) return { grant: existing, created: false };
      const grant: AdminGrant = {
        principalId,
        role: trustedRole,
        scopeId: scopeId("org", orgId),
        grantedBy: `trusted-oidc:${issuer}`,
        createdAt: now(),
      };
      await opts.users.record({ id: principalId, source: "admin", at: grant.createdAt ?? Date.now() });
      const created = await grants.addIfAbsent(tenant, grant);
      return { grant, created };
    },
    async provisionSelfServe(tenant, issuer, subject, email) {
      const principalId = trustedSubjectPrincipal(issuer, subject);
      const known = await opts.users.resolve(email ? [principalId, email] : [principalId]);
      if ([...known.values()].some((user) => user.offboardedAt !== undefined))
        throw new AdminError(403, "this person was removed from the workspace");
      const at = now();
      const grant: AdminGrant = {
        principalId,
        role: trustedRole,
        scopeId: scopeId("org", orgId),
        grantedBy: `trusted-oidc-self-serve:${issuer}`,
        createdAt: at,
      };
      const granted = known.size === 0 && (await grants.addIfAbsent(tenant, grant));
      await opts.users.record({ id: principalId, source: "admin", at });
      if (email)
        await opts.users
          .link({
            principalId: email,
            canonicalId: principalId,
            evidence: `verified email from ${issuer}`,
            linkedBy: "",
            createdAt: at,
          })
          .catch((error: unknown) => {
            if (!(error instanceof PrincipalLinkError)) throw error;
            console.warn(`[self-serve] email not linked to ${principalId} in ${tenant.id}: ${error.message}`);
          });
      return { grant, granted };
    },
    async listGrants(tenant) {
      return grants.list(tenant);
    },
    async createGrant(tenant, actor, input) {
      const actorRole = adminStatusFromGrants(await grants.list(tenant), actor.id).role;
      if (!actorRole) throw new AdminError(403, "only an org admin or owner may grant admin roles");
      const principalId = input.principalId?.trim();
      if (!principalId) throw new AdminError(400, "principalId required");
      const { role } = input;
      if (!isAdminRole(role)) {
        throw new AdminError(400, "role must be org_admin or owner");
      }
      if (role === "org_admin" && actorRole !== "org_admin") {
        throw new AdminError(403, "only an org admin may grant org_admin");
      }
      const parsed = parseScopeId(input.scopeId);
      if (parsed.kind !== "org" || parsed.ref !== orgId) {
        throw new AdminError(400, `${role} scope must be org:${orgId}`);
      }
      const grant: AdminGrant = { principalId, scopeId: input.scopeId, role, grantedBy: actor.id, createdAt: now() };
      await opts.users.record({ id: principalId, source: "admin", at: grant.createdAt ?? Date.now() });
      await grants.add(tenant, grant);
      return grant;
    },
    async revokeGrant(tenant, actor, principalId, scope, role) {
      const list = await grants.list(tenant);
      const actorRole = adminStatusFromGrants(list, actor.id).role;
      if (!actorRole) {
        throw new AdminError(403, "only an org admin or owner may revoke admin roles");
      }
      if (role === "org_admin" && actorRole !== "org_admin") {
        throw new AdminError(403, "only an org admin may revoke org_admin");
      }
      const matched = list.filter(
        (g) => samePerson(g.principalId, principalId) && g.scopeId === scope && g.role === role,
      );
      const distinctOrgAdmins = new Set(
        list.filter((g) => g.role === "org_admin").map((g) => personKey(g.principalId)),
      );
      if (role === "org_admin" && matched.length > 0 && distinctOrgAdmins.size <= 1) {
        throw new AdminError(400, "cannot revoke the last org admin");
      }
      if (role === "owner" && matched.length > 0 && distinctOrgAdmins.size === 0) {
        const distinctOwners = new Set(list.filter((g) => g.role === "owner").map((g) => personKey(g.principalId)));
        if (distinctOwners.size <= 1) {
          throw new AdminError(400, "cannot revoke the last owner");
        }
      }
      for (const g of matched) await grants.revoke(tenant, g.principalId, scope, role);
    },
  };
}
