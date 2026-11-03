import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANCY_BASE: PgMigrationDefinition = {
  id: "0000-tenancy/base",
  statements: [
    `CREATE TABLE IF NOT EXISTS tenants(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
      name TEXT NOT NULL CHECK (name <> ''),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE OR REPLACE FUNCTION qm_bound_tenant() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE AS $qm_bound_tenant$
DECLARE
  bound text := current_setting('qm.tenant_id', true);
BEGIN
  IF bound IS NULL OR bound = '' THEN
    RAISE insufficient_privilege USING MESSAGE = 'No tenant is bound to this query';
  END IF;
  RETURN bound::uuid;
END $qm_bound_tenant$`,
  ],
};

function tenantPolicies(table: string): string[] {
  return [
    `ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${table}
       USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`,
  ];
}

export const TENANT = "qm_bound_tenant()";

const tenantColumn = (table: string): string => `DO $tenant_column$
DECLARE
  tenant uuid;
  tenant_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ${table}) THEN
    ALTER TABLE ${table} ADD COLUMN tenant_id UUID NOT NULL;
    RETURN;
  END IF;
  SELECT count(*), min(id::text)::uuid INTO tenant_count, tenant FROM tenants;
  IF tenant_count = 0 AND to_regclass('qm_tenant') IS NOT NULL THEN
    EXECUTE 'SELECT id FROM qm_tenant' INTO tenant;
    INSERT INTO tenants(id, slug, name) VALUES (tenant, tenant::text, tenant::text);
  ELSIF tenant_count <> 1 THEN
    RAISE EXCEPTION 'Rows in ${table} need a tenant, but this database has % tenants', tenant_count;
  END IF;
  EXECUTE format('ALTER TABLE ${table} ADD COLUMN tenant_id UUID NOT NULL DEFAULT %L', tenant);
END $tenant_column$`;

interface TenantIndex {
  name: string;
  columns: string;
  where?: string;
}

interface TenantTable {
  table: string;
  primaryKey?: string;
  unique?: readonly (TenantIndex & { constraint?: boolean })[];
  replacesOrgId?: readonly TenantIndex[];
}

interface TenantForeignKey {
  table: string;
  name: string;
  columns: string;
  references: string;
  onDelete?: "CASCADE";
}

const indexOn = (table: string, { name, columns, where }: TenantIndex, unique = false): string =>
  `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON ${table}(tenant_id, ${columns})${where ? ` WHERE ${where}` : ""}`;

function typedTableStatements({ table, primaryKey, unique = [], replacesOrgId }: TenantTable): string[] {
  return [
    tenantColumn(table),
    ...(replacesOrgId
      ? [
          `DELETE FROM ${table} WHERE org_id IS DISTINCT FROM
             (SELECT org_id FROM ${table} GROUP BY org_id ORDER BY count(*) DESC, org_id LIMIT 1)`,
          `ALTER TABLE ${table} DROP COLUMN org_id`,
        ]
      : []),
    ...(primaryKey === undefined
      ? []
      : [
          `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey, ADD PRIMARY KEY (${["tenant_id", primaryKey].filter(Boolean).join(", ")})`,
        ]),
    ...unique.flatMap((index) => [
      index.constraint
        ? `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${index.name}`
        : `DROP INDEX IF EXISTS ${index.name}`,
      indexOn(table, index, true),
    ]),
    ...(replacesOrgId ?? []).map((index) => indexOn(table, index)),
    ...tenantPolicies(table),
  ];
}

export function tenantTables(
  id: string,
  tables: readonly TenantTable[],
  {
    foreignKeys = [],
    before = [],
    after = [],
  }: { foreignKeys?: readonly TenantForeignKey[]; before?: readonly string[]; after?: readonly string[] } = {},
): PgMigrationDefinition {
  return {
    id,
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      ...before,
      ...foreignKeys.map(({ table, name }) => `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`),
      ...tables.flatMap(typedTableStatements),
      ...foreignKeys.map(
        ({ table, name, columns, references, onDelete }) =>
          `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${onDelete ? ` ON DELETE ${onDelete}` : ""}`,
      ),
      ...after,
    ],
  };
}

export const FEATURE_FLAGS_MIGRATION: PgMigrationDefinition = {
  id: "tenants/0002-feature-flags",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `DO $qm_flags$ BEGIN
       IF to_regclass('feature_flags') IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('feature_flags') AND attname = 'feature_name'
       ) THEN
         ALTER TABLE feature_flags RENAME TO feature_flags_json;
       END IF;
     END $qm_flags$`,
    `CREATE TABLE IF NOT EXISTS feature_flags(
       tenant_id UUID NOT NULL,
       feature_name TEXT NOT NULL,
       enabled_scopes TEXT[] NOT NULL DEFAULT '{}',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_by TEXT NOT NULL,
       PRIMARY KEY (tenant_id, feature_name)
     )`,
    `DO $qm_flags_copy$ BEGIN
       IF to_regclass('feature_flags_json') IS NOT NULL THEN
         IF EXISTS (SELECT 1 FROM feature_flags_json) AND (SELECT count(*) FROM tenants) <> 1 THEN
           RAISE EXCEPTION 'Feature flags need a tenant, but this database has % tenants', (SELECT count(*) FROM tenants);
         END IF;
         INSERT INTO feature_flags(tenant_id, feature_name, enabled_scopes, updated_at, updated_by)
           SELECT (SELECT id FROM tenants), id,
                  ARRAY(SELECT jsonb_array_elements_text(COALESCE(json->'enabledScopes', '[]'::jsonb))),
                  to_timestamp(COALESCE((json->>'updatedAt')::double precision, 0) / 1000),
                  COALESCE(json->>'updatedBy', '')
           FROM feature_flags_json
           ON CONFLICT DO NOTHING;
         DROP TABLE feature_flags_json;
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = 'feature_flags';
         END IF;
       END IF;
     END $qm_flags_copy$`,
    ...tenantPolicies("feature_flags"),
  ],
};

export const TENANT_SETTINGS_MIGRATION: PgMigrationDefinition = {
  id: "tenants/0001-settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE tenant_settings(
         tenant_id UUID PRIMARY KEY,
         model_provider TEXT,
         pi_model TEXT,
         pi_detect_model TEXT,
         pi_title_model TEXT,
         pi_judge_model TEXT,
         anthropic_base_url TEXT,
         openai_base_url TEXT,
         openrouter_base_url TEXT,
         model_gateway_url TEXT,
         model_gateway_api_key TEXT,
         model_gateway_api_key_header TEXT,
         model_gateway_models TEXT,
         codex_auth_credential TEXT,
         claude_auth_credential TEXT,
         sandbox_backend TEXT,
         sprites_token TEXT,
         e2b_api_key TEXT,
         modal_token_id TEXT,
         modal_token_secret TEXT,
         do_agents_api_token TEXT,
         smolmachines_token TEXT,
         agent37_api_key TEXT,
         superserve_api_key TEXT,
         render_sandbox_api_key TEXT,
         render_sandbox_workspace_id TEXT,
         security_screen TEXT,
         security_screen_classifier TEXT,
         security_screen_proxy_provider TEXT,
         security_screen_proxy_endpoint TEXT,
         security_screen_proxy_token TEXT,
         auth_allowed_emails TEXT,
         auth_allowed_email_domain TEXT,
         trusted_oidc_admin_issuer TEXT,
         suggested_activities_context TEXT,
         admin_grants TEXT,
         oidc_issuer TEXT,
         oidc_auth_endpoint TEXT,
         oidc_token_endpoint TEXT,
         oidc_userinfo_endpoint TEXT,
         oidc_jwks_uri TEXT,
         oidc_client_id TEXT,
         oidc_scopes TEXT,
         oidc_prompt TEXT,
         oidc_principal_claim TEXT,
         oidc_allowed_email_domain TEXT,
         oidc_allowed_emails TEXT,
         portal_expected_team_id TEXT,
         oidc_client_secret TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ...tenantPolicies("tenant_settings"),
  ],
};
