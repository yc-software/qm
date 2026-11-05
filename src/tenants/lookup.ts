import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";
import { loadTenant } from "./cache.ts";
import { withTenant } from "./context.ts";

const ACTIVE = `json->>'disabled' IS DISTINCT FROM 'true'`;

const KEYS = {
  slack_team: `SELECT tenant_id FROM slack_installation WHERE json->>'teamId' = $1 AND ${ACTIVE}`,
  webhook: `SELECT tenant_id FROM webhooks WHERE id = $1`,
  loop_ingress: `SELECT tenant_id FROM loop_ingress WHERE id = $1`,
  oauth_flow: `SELECT tenant_id FROM oauth_flows WHERE id = $1`,
  consent_link: `SELECT tenant_id FROM consent_links WHERE id = $1`,
  deployment: `SELECT tenant_id FROM deployments WHERE id = $1 OR json->>'name' = $1`,
  share: `SELECT tenant_id FROM session_shares WHERE id = $1`,
  secret_drop: `SELECT tenant_id FROM secret_drops WHERE id = $1`,
} as const;

export type TenantKey = keyof typeof KEYS;

const definer = (name: string, returns: string, body: string): string =>
  `CREATE OR REPLACE FUNCTION ${name}(key text) RETURNS ${returns}
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $lookup$ ${body} $lookup$`;

export const TENANT_LOOKUPS: PgMigrationDefinition = {
  id: "tenancy/lookups/0001",
  statements: [
    `SET LOCAL check_function_bodies = off`,
    ...Object.entries(KEYS).map(([key, rows]) =>
      definer(
        `qm_tenant_for_${key}`,
        "uuid",
        `SELECT (array_agg(DISTINCT tenant_id))[1] FROM (${rows}) found HAVING count(DISTINCT tenant_id) = 1`,
      ),
    ),
    definer(
      "qm_tenants_for_gmail",
      "SETOF uuid",
      `SELECT DISTINCT tenant_id FROM loop_ingress
        WHERE json->>'kind' = 'gmail' AND json->'gmail'->>'email' = lower($1) AND json->>'enabled' = 'true'`,
    ),
  ],
};

export const SLACK_TENANTS: PgMigrationDefinition = {
  id: "tenancy/lookups/0002-slack-tenants",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_tenants_with_slack() RETURNS SETOF uuid
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $lookup$ BEGIN RETURN QUERY SELECT DISTINCT tenant_id FROM slack_installation WHERE ${ACTIVE}; END $lookup$`,
  ],
};

export const PRINCIPAL_TENANTS: PgMigrationDefinition = {
  id: "tenancy/lookups/0003-principal-tenants",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_tenants_for_principal(principal text) RETURNS SETOF uuid
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $lookup$ BEGIN
        RETURN QUERY SELECT DISTINCT tenant_id FROM principal_links
          WHERE id = principal OR json->>'canonicalId' = principal;
      END $lookup$`,
  ],
};

export interface TenantLookup {
  tenantFor(key: TenantKey, value: string | undefined): Promise<string | undefined>;
  gmailTenants(email: string): Promise<string[]>;
  slackTenants(): Promise<string[]>;
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
  };
}

export function inTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return withTenant(tenant, async () => {
    await loadTenant();
    return fn();
  });
}
