import type { PgPool } from "../persistence/pg-pool.ts";
import { type Tenant, withTenant } from "./context.ts";

export type TenantKey =
  | "slack_team"
  | "webhook"
  | "loop_ingress"
  | "oauth_flow"
  | "consent_link"
  | "deployment"
  | "share"
  | "secret_drop"
  | "slack_bridge"
  | "teams_tenant"
  | "app_host";

export interface TenantLookup {
  tenantFor(key: TenantKey, value: string | undefined): Promise<string | undefined>;
  externalOrgTenant(issuer: string, org: string): Promise<string | undefined>;
  boundExternalOrg(tenant: Tenant, issuer: string): Promise<string | undefined>;
  gmailTenants(email: string): Promise<string[]>;
  slackTenants(): Promise<string[]>;
  exists(tenant: string): Promise<boolean>;
}

export function tenantLookup(pg: Pick<PgPool, "q" | "forTenant">): TenantLookup {
  const tenantFrom = async (sql: string, params: string[]) => {
    const tenant = (await pg.q(sql, params))[0]?.tenant;
    return typeof tenant === "string" ? tenant : undefined;
  };
  return {
    async tenantFor(key, value) {
      return value ? tenantFrom(`SELECT qm_tenant_for_${key}($1)::text AS tenant`, [value]) : undefined;
    },
    externalOrgTenant: (issuer, org) =>
      tenantFrom("SELECT qm_tenant_for_external_org($1, $2)::text AS tenant", [issuer, org]),
    async boundExternalOrg(tenant, issuer) {
      const org = (await pg.forTenant(tenant).q("SELECT qm_bound_external_org($1) AS org", [issuer]))[0]?.org;
      return typeof org === "string" ? org : undefined;
    },
    async gmailTenants(email) {
      const rows = await pg.q("SELECT tenant::text AS tenant FROM qm_tenants_for_gmail($1) tenant", [email]);
      return rows.map((row) => String(row.tenant));
    },
    async slackTenants() {
      const rows = await pg.q("SELECT tenant::text AS tenant FROM qm_tenants_with_slack() tenant");
      return rows.map((row) => String(row.tenant));
    },
    async exists(tenant) {
      const rows = await withTenant(tenant, () => pg.q("SELECT 1 FROM tenants WHERE id = qm_bound_tenant()"));
      return rows.length === 1;
    },
  };
}
