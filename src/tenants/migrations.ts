import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANT = "qm_tenant_id()";

const SCOPE_COLUMN_TYPES = `'text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype`;

const UNREWRITTEN_TABLES = `'tenants', 'qm_schema_migrations', 'items', 'tool_calls', 'llm_prompt_envelopes',
  'session_llm_requests', 'channel_messages', 'channel_files', 'runs', 'run_activity', 'run_signals', 'deliveries',
  'audit_log', 'egress_events', 'error_events', 'credential_usage', 'cron_fires', 'webhook_history'`;

const hashIdSql = (...parts: string[]) =>
  String.raw`left(encode(sha256(${parts.map((part) => `convert_to(${part}, 'UTF8')`).join(String.raw` || '\x00'::bytea || `)}), 'hex'), 16)`;

const CREDENTIAL_SLOTS = String.raw`(VALUES ('broker'), ('file'), ('oauth:'),
  ('env:' || coalesce(k.json->>'envKey', '')),
  ('oauth:' || coalesce(nullif(k.json->'refresh'->>'accountType', 'default'), '')),
  ('env:' || coalesce((SELECT string_agg(f->>'envKey', ',' ORDER BY f->>'envKey' COLLATE "C")
    FROM jsonb_array_elements(k.json->'fields') f), ''))) s(slot)`;

export const TENANT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0047-tenants",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE tenants(
         id UUID PRIMARY KEY,
         slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
         name TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `INSERT INTO tenants(id, slug, name) SELECT id, 'main', 'Main' FROM qm_tenant`,
      `CREATE OR REPLACE FUNCTION qm_tenant_unbound() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE
         AS $qm_tenant_unbound$ BEGIN
           RAISE 'No tenant is bound to this transaction' USING ERRCODE = 'insufficient_privilege';
         END $qm_tenant_unbound$`,
      `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
         AS $qm_tenant_id$ SELECT COALESCE(NULLIF(current_setting('qm.tenant_id', true), '')::uuid, qm_tenant_unbound()) $qm_tenant_id$`,
      `ALTER TABLE items ALTER COLUMN tenant_id SET DEFAULT qm_tenant_id()`,
      `ALTER TABLE items ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE items FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON items
         USING (tenant_id = qm_tenant_id()) WITH CHECK (tenant_id = qm_tenant_id())`,
      `DROP TABLE qm_tenant`,
    ],
  },
  {
    id: "sessions/store/0050-tenant-root-scope",
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
