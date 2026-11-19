import type { PgPool } from "../persistence/pg-pool.ts";
import { withTenant } from "./context.ts";

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
  | "partner_chat"
  | "app_host";

export interface TenantLookup {
  tenantFor(key: TenantKey, value: string | undefined): Promise<string | undefined>;
  gmailTenants(email: string): Promise<string[]>;
  slackTenants(): Promise<string[]>;
  exists(tenant: string): Promise<boolean>;
}

export function tenantLookup(pg: Pick<PgPool, "q">): TenantLookup {
  return {
    async tenantFor(key, value) {
      if (!value) return undefined;
      const rows = await pg.q(`SELECT qm_tenant_for_${key}($1)::text AS tenant`, [value]);
      const tenant = rows[0]?.tenant;
      return typeof tenant === "string" ? tenant : undefined;
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
