import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANT = "qm_bound_tenant()";
const MATCH = `tenant_id = ${TENANT}`;

const TENANT_FUNCTIONS = [
  `CREATE OR REPLACE FUNCTION qm_tenant_unbound() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE
     AS $qm_tenant_unbound$ BEGIN
       RAISE 'No tenant is bound to this transaction' USING ERRCODE = 'insufficient_privilege';
     END $qm_tenant_unbound$`,
  `CREATE OR REPLACE FUNCTION qm_bound_tenant() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
     AS $qm_bound_tenant$ SELECT COALESCE(NULLIF(current_setting('qm.tenant_id', true), '')::uuid, qm_tenant_unbound()) $qm_bound_tenant$`,
];

function grantsWhereAllowed(statements: readonly string[]): string {
  return `DO $qm_grants$ DECLARE statement text; BEGIN
     FOREACH statement IN ARRAY ARRAY[${statements.join(", ")}] LOOP
       BEGIN
         EXECUTE statement;
       EXCEPTION WHEN insufficient_privilege THEN
         RAISE WARNING 'Skipped % (%)', statement, SQLERRM;
       END;
     END LOOP;
   END $qm_grants$`;
}

export const TENANCY_BASE: PgMigrationDefinition = {
  id: "0000-tenancy/base",
  statements: [
    `DO $qm_logins$ BEGIN
       IF current_user IN ('qm_app', 'qm_reader') THEN
         RAISE 'Migrations must run as the owner login, not %', current_user;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_app') THEN
         BEGIN
           CREATE ROLE qm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
         EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
         END;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_reader') THEN
         BEGIN
           CREATE ROLE qm_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
         EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
         END;
       END IF;
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('qm_app', 'qm_reader') AND (rolsuper OR rolbypassrls)) THEN
         RAISE 'qm_app and qm_reader must not bypass row-level security';
       END IF;
     END $qm_logins$`,
    `CREATE TABLE IF NOT EXISTS tenants(
       id UUID PRIMARY KEY,
       slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
       name TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    ...["tenants", "qm_schema_migrations"].flatMap((table) => [
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS read_only ON ${table}`,
      `CREATE POLICY read_only ON ${table} FOR SELECT TO qm_app, qm_reader USING (true)`,
    ]),
    grantsWhereAllowed([
      `format('GRANT USAGE ON SCHEMA %I TO qm_app, qm_reader', current_schema())`,
      `format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO qm_app', current_schema())`,
      `format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO qm_reader', current_schema())`,
      `format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO qm_app', current_schema())`,
      `'ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app'`,
      `'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO qm_reader'`,
      `'ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO qm_app'`,
      `'ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO qm_app, qm_reader'`,
    ]),
    ...TENANT_FUNCTIONS,
    `CREATE OR REPLACE FUNCTION qm_tenant_column(target regclass) RETURNS void LANGUAGE plpgsql
     AS $qm_tenant_column$
     DECLARE
       populated boolean;
       present boolean;
       tenant uuid;
       tenant_count bigint;
     BEGIN
       EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', target) INTO populated;
       SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = 'tenant_id' AND NOT attisdropped)
         INTO present;
       IF populated THEN
         SELECT count(*), min(id::text)::uuid INTO tenant_count, tenant FROM tenants;
         IF tenant_count = 0 THEN
           IF to_regclass('qm_tenant') IS NOT NULL THEN
             EXECUTE 'SELECT id FROM qm_tenant' INTO tenant;
           END IF;
           INSERT INTO tenants(id, slug, name) VALUES (COALESCE(tenant, gen_random_uuid()), 'main', 'Main')
             RETURNING id INTO tenant;
         ELSIF tenant_count > 1 AND NOT present THEN
           RAISE 'Rows in % need a tenant but this database has % tenants', target, tenant_count;
         END IF;
       END IF;
       IF NOT present AND populated THEN
         EXECUTE format('ALTER TABLE %s ADD COLUMN tenant_id UUID NOT NULL DEFAULT %L', target, tenant);
       ELSIF NOT present THEN
         EXECUTE format('ALTER TABLE %s ADD COLUMN tenant_id UUID NOT NULL', target);
       END IF;
       EXECUTE format('ALTER TABLE %s ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()', target);
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = target AND contype = 'f'
                        AND confrelid = 'tenants'::regclass) THEN
         EXECUTE format('ALTER TABLE %s ADD FOREIGN KEY (tenant_id) REFERENCES tenants', target);
       END IF;
     END $qm_tenant_column$`,
    grantsWhereAllowed([`'REVOKE ALL ON FUNCTION qm_tenant_column(regclass) FROM PUBLIC'`]),
  ],
};

export function tenantPolicies(table: string): string[] {
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_app ON ${table}`,
    `DROP POLICY IF EXISTS tenant_reader ON ${table}`,
    `CREATE POLICY tenant_app ON ${table} FOR ALL TO qm_app USING (${MATCH}) WITH CHECK (${MATCH})`,
    `CREATE POLICY tenant_reader ON ${table} FOR SELECT TO qm_reader USING (${MATCH})`,
  ];
}

interface TenantIndex {
  name: string;
  columns: string;
  where?: string;
}

export interface TenantTable {
  table: string;
  primaryKey?: string;
  unique?: readonly (TenantIndex & { constraint?: boolean })[];
  replacesOrgId?: readonly TenantIndex[];
}

export interface TenantForeignKey {
  table: string;
  name: string;
  columns: string;
  references: string;
  onDelete?: "CASCADE";
}

const indexOn = (table: string, { name, columns, where }: TenantIndex, unique = false): string =>
  `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ON ${table}(tenant_id, ${columns})${where ? ` WHERE ${where}` : ""}`;

function tenantTableStatements({ table, primaryKey, unique = [], replacesOrgId }: TenantTable): string[] {
  return [
    `SELECT qm_tenant_column('${table}')`,
    ...(replacesOrgId
      ? [
          `DO $qm_one_org$ BEGIN
             IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = 'org_id') THEN
               DELETE FROM ${table} WHERE org_id IS DISTINCT FROM
                 (SELECT org_id FROM ${table} GROUP BY org_id ORDER BY count(*) DESC, org_id LIMIT 1);
             END IF;
           END $qm_one_org$`,
          `ALTER TABLE ${table} DROP COLUMN IF EXISTS org_id`,
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
      ...tables.flatMap(tenantTableStatements),
      ...foreignKeys.map(
        ({ table, name, columns, references, onDelete }) =>
          `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${onDelete ? ` ON DELETE ${onDelete}` : ""}`,
      ),
      ...after,
    ],
  };
}

const SPEND_TRIGGERS = [
  `CREATE OR REPLACE FUNCTION invalidate_request_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_request_spend$
   BEGIN
     INSERT INTO session_spend_dirty(tenant_id, day)
     SELECT DISTINCT tenant, floor(at::numeric / 86400000)::bigint
       FROM (VALUES
         (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.tenant_id END,
          CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
         (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.tenant_id END,
          CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
       ) changed(tenant, at) WHERE at IS NOT NULL
     ON CONFLICT DO NOTHING;
     RETURN NULL;
   END $invalidate_request_spend$`,
  `CREATE OR REPLACE FUNCTION invalidate_session_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_session_spend$
   BEGIN
     IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
          IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
       RETURN NULL;
     END IF;
     INSERT INTO session_spend_dirty(tenant_id, session_id)
     SELECT DISTINCT tenant, id FROM (VALUES (OLD.tenant_id, OLD.id), (NEW.tenant_id, NEW.id)) changed(tenant, id)
      WHERE id IS NOT NULL;
     RETURN NULL;
   END $invalidate_session_spend$`,
];

const ITEM_SEARCH = [
  `DO $qm_search_items$ BEGIN
     EXECUTE format($create$
       CREATE OR REPLACE FUNCTION qm_search_items(query tsquery) RETURNS TABLE(session_id text, seq bigint)
         LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp
         AS $body$ SELECT i.session_id, i.seq FROM items i WHERE i.tenant_id = qm_bound_tenant() AND i.search @@ query $body$
     $create$, current_schema());
   END $qm_search_items$`,
  grantsWhereAllowed([
    `'REVOKE ALL ON FUNCTION qm_search_items(tsquery) FROM PUBLIC'`,
    `'GRANT EXECUTE ON FUNCTION qm_search_items(tsquery) TO qm_app, qm_reader'`,
  ]),
];

const SCOPE_COLUMN_TYPES = `'text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype`;

const UNREWRITTEN_TABLES = `'tenants', 'qm_schema_migrations', 'items', 'tool_calls', 'llm_prompt_envelopes',
  'session_llm_requests', 'channel_messages', 'channel_files', 'runs', 'run_activity', 'run_signals', 'deliveries',
  'audit_log', 'egress_events', 'error_events', 'credential_usage', 'cron_fires'`;

const hashIdSql = (...parts: string[]) =>
  String.raw`left(encode(sha256(${parts.map((part) => `convert_to(${part}, 'UTF8')`).join(String.raw` || '\x00'::bytea || `)}), 'hex'), 16)`;

const CREDENTIAL_SLOTS = String.raw`(VALUES ('broker'), ('file'), ('oauth:'),
  ('env:' || coalesce(k.json->>'envKey', '')),
  ('oauth:' || coalesce(nullif(k.json->'refresh'->>'accountType', 'default'), '')),
  ('env:' || coalesce((SELECT string_agg(f->>'envKey', ',' ORDER BY f->>'envKey' COLLATE "C")
    FROM jsonb_array_elements(k.json->'fields') f), ''))) s(slot)`;

export const TENANT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0048-tenants",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      ...TENANT_FUNCTIONS,
      `SELECT qm_tenant_column('items')`,
      `SELECT qm_tenant_column('blobs')`,
      ...tenantPolicies("items"),
      ...tenantPolicies("blobs"),
      `DO $qm_tenant_seed$ BEGIN
         IF to_regclass('qm_tenant') IS NOT NULL THEN
           INSERT INTO tenants(id, slug, name) SELECT id, 'main', 'Main' FROM qm_tenant
            WHERE NOT EXISTS (SELECT 1 FROM tenants)
              AND (EXISTS (SELECT 1 FROM sessions) OR 'sessions/store/0047-base-schema' =
                ANY (string_to_array(current_setting('qm.migrations_before_run', true), ',')));
         END IF;
       END $qm_tenant_seed$`,
      `DROP FUNCTION IF EXISTS qm_tenant_id()`,
      `DROP TABLE IF EXISTS qm_tenant`,
    ],
  },
  tenantTables(
    "sessions/store/0049-tenant-sessions",
    [
      {
        table: "sessions",
        primaryKey: "id",
        unique: [{ name: "sessions_thread_ref_key", columns: "thread_ref", constraint: true }],
      },
      { table: "participants", primaryKey: "session_id, principal_id" },
      { table: "session_goals", primaryKey: "session_id" },
      { table: "session_leases", primaryKey: "session_id" },
      { table: "session_llm_requests", primaryKey: "id" },
      { table: "session_pins", primaryKey: "id" },
      { table: "session_spend_days", primaryKey: "day" },
      {
        table: "session_spend_dirty",
        unique: [{ name: "session_spend_dirty_day_writer_key", columns: "day, writer", constraint: true }],
      },
      { table: "llm_prompt_envelopes", primaryKey: "hash" },
    ],
    {
      foreignKeys: [
        {
          table: "session_goals",
          name: "session_goals_session_id_fkey",
          columns: "session_id",
          references: "sessions(tenant_id, id)",
          onDelete: "CASCADE",
        },
        {
          table: "items",
          name: "items_session_id_fkey",
          columns: "session_id",
          references: "sessions(tenant_id, id)",
          onDelete: "CASCADE",
        },
      ],
      after: [...SPEND_TRIGGERS, ...ITEM_SEARCH, `DROP TABLE IF EXISTS qm_settings`],
    },
  ),
  {
    id: "sessions/store/0050-agent-reply-index",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS items_agent_reply
         ON items(tenant_id, session_id, created_at DESC) WHERE kind = 'AgentMessage'`,
    ],
  },
  {
    id: "sessions/store/0051-tenant-root-scope",
    statements: [
      `ALTER TABLE tenants ADD COLUMN composio_namespace TEXT`,
      String.raw`DO $qm_root_scope$
       DECLARE
         old_org text;
         tenant uuid;
         needle text;
         pattern text;
         replacement text;
         rel record;
         tenant_count bigint;
       BEGIN
         IF to_regclass('deployment_identity') IS NULL THEN RETURN; END IF;
         SELECT json->>'orgId' INTO old_org FROM deployment_identity WHERE id = 'singleton';
         DROP TABLE deployment_identity;
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = 'deployment_identity';
         END IF;
         IF old_org IS NULL THEN RETURN; END IF;
         SELECT count(*), min(id::text)::uuid INTO tenant_count, tenant FROM tenants;
         IF tenant_count = 0 THEN RETURN; END IF;
         IF tenant_count > 1 THEN RAISE EXCEPTION 'root scope migration expects one tenant, found %', tenant_count; END IF;
         UPDATE tenants SET composio_namespace = old_org WHERE id = tenant;
         PERFORM set_config('qm.tenant_id', tenant::text, true);
         needle := 'org:' || old_org;
         replacement := 'org:' || tenant::text;
         pattern := '(^|["{,])((?:system:)?)' || regexp_replace(needle, '([^A-Za-z0-9])', '\\\1', 'g') || '(?=$|["}|:,])';
         replacement := '\1\2' || replacement;
         FOR rel IN
           SELECT c.oid::regclass AS tbl,
             string_agg(format('%1$I = CASE WHEN strpos(%1$I::text, %2$L) > 0 THEN regexp_replace(%1$I::text, %3$L, %4$L, %5$L)::%6$s ELSE %1$I END',
               a.attname, needle, pattern, replacement, 'g', format_type(a.atttypid, NULL)), ', ') AS sets,
             string_agg(format('strpos(%I::text, %L) > 0', a.attname, needle), ' OR ') AS conds
           FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
           WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
             AND c.relname NOT IN (${UNREWRITTEN_TABLES})
             AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
             AND a.atttypid IN (${SCOPE_COLUMN_TYPES})
           GROUP BY c.oid
         LOOP
           EXECUTE format('UPDATE %s SET %s WHERE %s', rel.tbl, rel.sets, rel.conds);
         END LOOP;
         FOR rel IN
           SELECT c.oid::regclass AS tbl
           FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
           WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
             AND a.attname = 'org_id' AND NOT a.attisdropped AND a.atttypid = 'text'::regtype
         LOOP
           EXECUTE format('UPDATE %s SET org_id = $1 WHERE org_id = $2', rel.tbl) USING tenant::text, old_org;
         END LOOP;
         IF to_regclass('ambient_cursors') IS NOT NULL THEN
           UPDATE ambient_cursors SET id = tenant::text || substr(id, length(old_org) + 1)
             WHERE starts_with(id, old_org || ':');
         END IF;
         IF to_regclass('keychain_credentials') IS NOT NULL THEN
           CREATE TEMP TABLE qm_credential_ids ON COMMIT DROP AS
             SELECT DISTINCT k.id AS old_id, ${hashIdSql("k.json->>'ownerId'", "k.json->>'service'", "s.slot")} AS new_id
             FROM keychain_credentials k CROSS JOIN LATERAL ${CREDENTIAL_SLOTS}
             WHERE k.json->>'ownerId' = 'org:' || tenant::text
               AND k.id = ${hashIdSql("needle", "k.json->>'service'", "s.slot")};
           DELETE FROM qm_credential_ids WHERE old_id = new_id;
           UPDATE keychain_credentials k SET id = m.new_id, json = jsonb_set(k.json, '{id}', to_jsonb(m.new_id))
             FROM qm_credential_ids m WHERE k.id = m.old_id;
           IF to_regclass('keychain_grants') IS NOT NULL THEN
             UPDATE keychain_grants g SET json = jsonb_set(g.json, '{credentialId}', to_jsonb(m.new_id))
               FROM qm_credential_ids m WHERE g.json->>'credentialId' = m.old_id;
             CREATE TEMP TABLE qm_grant_ids ON COMMIT DROP AS
               SELECT g.id AS old_id, ${hashIdSql("g.json->>'credentialId'", "'ask'", "g.json->>'askId'")} AS new_id
               FROM keychain_grants g JOIN qm_credential_ids m ON g.json->>'credentialId' = m.new_id
               WHERE g.json ? 'askId';
             DELETE FROM qm_grant_ids WHERE old_id = new_id;
             UPDATE keychain_grants g SET id = m.new_id, json = jsonb_set(g.json, '{id}', to_jsonb(m.new_id))
               FROM qm_grant_ids m WHERE g.id = m.old_id;
             IF to_regclass('keychain_asks') IS NOT NULL THEN
               UPDATE keychain_asks q SET json = jsonb_set(q.json, '{grantId}', to_jsonb(m.new_id))
                 FROM qm_grant_ids m WHERE q.json->>'grantId' = m.old_id;
             END IF;
           END IF;
           IF to_regclass('keychain_asks') IS NOT NULL THEN
             UPDATE keychain_asks q SET json = jsonb_set(q.json, '{credentialId}', to_jsonb(m.new_id))
               FROM qm_credential_ids m WHERE q.json->>'credentialId' = m.old_id;
           END IF;
         END IF;
       END $qm_root_scope$`,
    ],
  },
];

export const TENANT_SETTINGS_MIGRATION: PgMigrationDefinition = {
  id: "tenants/0001-settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE tenant_settings(
         tenant_id UUID PRIMARY KEY DEFAULT qm_bound_tenant() REFERENCES tenants ON DELETE CASCADE,
         model_provider TEXT,
         pi_model TEXT,
         pi_detect_model TEXT,
         pi_title_model TEXT,
         pi_judge_model TEXT,
         anthropic_base_url TEXT,
         openai_base_url TEXT,
         openrouter_base_url TEXT,
         model_gateway_url TEXT,
         model_gateway_api_key BYTEA,
         model_gateway_api_key_header TEXT,
         model_gateway_models TEXT,
         codex_auth_credential TEXT,
         claude_auth_credential TEXT,
         sandbox_backend TEXT,
         sprites_token BYTEA,
         e2b_api_key BYTEA,
         modal_token_id BYTEA,
         modal_token_secret BYTEA,
         do_agents_api_token BYTEA,
         smolmachines_token BYTEA,
         render_sandbox_api_key BYTEA,
         render_sandbox_workspace_id TEXT,
         security_screen TEXT,
         security_screen_classifier TEXT,
         security_screen_proxy_provider TEXT,
         security_screen_proxy_endpoint TEXT,
         security_screen_proxy_token BYTEA,
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
         oidc_client_secret BYTEA,
         admin_grants TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ...tenantPolicies("tenant_settings"),
  ],
};
