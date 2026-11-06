import { durableMapTenancy } from "../persistence/durable-map.ts";
import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";
import { fold } from "../identity/user-tenancy.ts";
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

export function inboundIndexes(table: string, fields: readonly string[] = []): PgMigrationDefinition {
  return {
    id: `tenancy/lookups/${table}-inbound-indexes`,
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_inbound_id ON ${table} (id)`,
      ...fields.map(
        (field) =>
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_inbound_${field.toLowerCase()}
            ON ${table} ((json->>'${field}')) WHERE json->>'${field}' IS NOT NULL`,
      ),
    ],
  };
}

export function inboundTenancy(table: string): PgMigrationDefinition[] {
  return [...durableMapTenancy(table), inboundIndexes(table)];
}

export type TenantKey = keyof typeof KEYS | "slack_bridge" | "app_host";

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

export const PRINCIPAL_ADMIN_TENANTS: PgMigrationDefinition = {
  id: "tenancy/lookups/0005-principal-admin-tenants",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_tenants_for_principal(principal text) RETURNS SETOF uuid
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $lookup$ BEGIN
        RETURN QUERY
          SELECT l.tenant_id FROM principal_links l WHERE l.id = principal OR l.json->>'canonicalId' = principal
          UNION
          SELECT g.tenant_id FROM admin_grants g WHERE g.principal_id = principal
          UNION
          SELECT g.tenant_id FROM admin_grants g JOIN principal_links l ON l.tenant_id = g.tenant_id
            WHERE (l.id = principal AND g.principal_id = l.json->>'canonicalId')
               OR (l.json->>'canonicalId' = principal AND g.principal_id = l.id);
      END $lookup$`,
  ],
};

const ACTIVE_PERSON = `JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            AND u.kind = 'person' AND u.offboarded_at IS NULL`;

export const PRINCIPAL_USER_TENANTS: PgMigrationDefinition = {
  id: "tenancy/lookups/0006-principal-user-tenants",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_tenants_for_principal(principal text) RETURNS SETOF uuid
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $lookup$ BEGIN
        RETURN QUERY
          SELECT l.tenant_id FROM user_links l ${ACTIVE_PERSON} WHERE l.alias_id = ${fold("principal")}
          UNION
          SELECT g.tenant_id FROM admin_grants g WHERE g.principal_id = principal
          UNION
          SELECT g.tenant_id FROM admin_grants g
            JOIN user_links o ON o.tenant_id = g.tenant_id AND o.alias_id = ${fold("g.principal_id")}
            JOIN user_links l ON l.tenant_id = o.tenant_id AND l.user_id = o.user_id
           WHERE l.alias_id = ${fold("principal")};
      END $lookup$`,
  ],
};

export const EMAIL_USER_TENANTS: PgMigrationDefinition = {
  id: "directory/store/0010-tenants-for-email-users",
  statements: [
    `DO $tenants_for_email$
BEGIN
  EXECUTE format(
    $function$CREATE OR REPLACE FUNCTION qm_tenants_for_email(email text) RETURNS TABLE(tenant_id uuid)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $body$ BEGIN
      RETURN QUERY
        SELECT m.tenant_id FROM directory_members m
         WHERE lower(m.principal_id) = lower(email) AND m.type = 'internal'
        UNION
        SELECT g.tenant_id FROM admin_grants g WHERE lower(g.principal_id) = lower(email)
        UNION
        SELECT l.tenant_id FROM user_links l ${ACTIVE_PERSON} WHERE l.alias_id = lower(btrim(email));
    END $body$$function$,
    current_schema());
END $tenants_for_email$`,
  ],
};

export const SLACK_BRIDGE_TENANT: PgMigrationDefinition = {
  id: "tenancy/lookups/0004-slack-bridge",
  statements: [
    `SET LOCAL check_function_bodies = off`,
    definer(
      "qm_tenant_for_slack_bridge",
      "uuid",
      `SELECT (array_agg(id))[1] FROM tenants WHERE settings->>'slackBridgeToken' = $1 HAVING count(*) = 1`,
    ),
  ],
};

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
