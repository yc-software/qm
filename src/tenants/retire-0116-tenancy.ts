import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

const CONSTRAINT_KEYS = [
  "deliveries_idempotency_key_key",
  "runs_idempotency_key_key",
  "session_spend_dirty_day_writer_key",
  "sessions_thread_ref_key",
  "user_links_user_id_alias_id_key",
  "users_primary_alias_key",
];

const HOST_OBJECTS = [
  "DROP TRIGGER IF EXISTS tenants_retire_hosts ON tenants",
  "DROP TABLE IF EXISTS retired_tenant_hosts, tenant_hosts",
  "DROP FUNCTION IF EXISTS qm_retire_tenant_hosts(), qm_host_tenant(text), qm_tenant_settings(), qm_sole_tenant()",
];

export const RETIRE_0116_HOSTS: PgMigrationDefinition = {
  id: "0000-tenancy/retire-0116-hosts",
  statements: [`SET LOCAL lock_timeout = '5s'`, ...HOST_OBJECTS, "DROP FUNCTION IF EXISTS qm_tenant_for_host(text)"],
};

export function retire0116Tenancy(boundTenant: string): PgMigrationDefinition {
  return {
    id: "0000-tenancy/base/retire-0116-keys",
    statements: [
      `DO $retire_tenant_keys$
DECLARE
  constraint_keys CONSTANT text[] := ARRAY[${CONSTRAINT_KEYS.map((name) => `'${name}'`).join(", ")}];
  kept CONSTANT text[] := ARRAY['items', 'blobs'];
  registry CONSTANT text[] := ARRAY['tenants', 'tenant_hosts', 'retired_tenant_hosts'];
  actions CONSTANT jsonb := '{"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}';
  t record;
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id LIKE '%-tenants/1-column') THEN
    RETURN;
  END IF;
  CREATE TEMP TABLE tenant_cols ON COMMIT DROP AS
    SELECT a.attrelid AS rel, a.attnum AS num, c.relname
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
       AND a.attname = 'tenant_id' AND NOT a.attisdropped
       AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation');
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint k JOIN tenant_cols tc ON tc.rel = k.conrelid
     WHERE k.contype = 'p' AND k.conkey[1] = tc.num AND NOT tc.relname = ANY(kept || registry)
  ) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM tenants) > 1 THEN
    RAISE EXCEPTION 'This database holds % tenants from release 0.1.16; only a single-tenant 0.1.16 database can be upgraded.',
      (SELECT count(*) FROM tenants);
  END IF;

  CREATE TEMP TABLE retired_fks ON COMMIT DROP AS
    SELECT k.conrelid, k.conname,
           format('FOREIGN KEY (%s) REFERENCES %s(%s) ON UPDATE %s ON DELETE %s',
             (SELECT string_agg(quote_ident(attname), ', ' ORDER BY n) FROM unnest(k.conkey[2:]) WITH ORDINALITY u(col, n)
                JOIN pg_attribute ON attrelid = k.conrelid AND attnum = u.col),
             k.confrelid::regclass,
             (SELECT string_agg(quote_ident(attname), ', ' ORDER BY n) FROM unnest(k.confkey[2:]) WITH ORDINALITY u(col, n)
                JOIN pg_attribute ON attrelid = k.confrelid AND attnum = u.col),
             actions->>k.confupdtype::text, actions->>k.confdeltype::text) AS def
      FROM pg_constraint k
      JOIN tenant_cols src ON src.rel = k.conrelid AND k.conkey[1] = src.num
      JOIN tenant_cols dst ON dst.rel = k.confrelid AND k.confkey[1] = dst.num
     WHERE k.contype = 'f' AND cardinality(k.conkey) > 1 AND NOT dst.relname = ANY(kept);
  FOR r IN
    SELECT k.conrelid::regclass AS tbl, k.conname FROM pg_constraint k JOIN tenant_cols tc ON tc.rel = k.conrelid
     WHERE k.contype = 'f' AND tc.num = ANY(k.conkey) AND NOT tc.relname = ANY(registry)
       AND (k.confrelid = 'tenants'::regclass OR k.conname IN (SELECT conname FROM retired_fks WHERE conrelid = k.conrelid))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;

  FOR t IN SELECT rel, num, relname FROM tenant_cols WHERE NOT relname = ANY(registry) LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.relname);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY', t.relname);
    IF t.relname = ANY(kept) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t.relname);
      CONTINUE;
    END IF;
    FOR r IN
      SELECT k.conname, CASE k.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS kind,
             (SELECT string_agg(quote_ident(attname), ', ' ORDER BY n) FROM unnest(k.conkey[2:]) WITH ORDINALITY u(col, n)
                JOIN pg_attribute ON attrelid = t.rel AND attnum = u.col) AS cols
        FROM pg_constraint k
       WHERE k.conrelid = t.rel AND k.contype IN ('p', 'u') AND k.conkey[1] = t.num
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I, ADD CONSTRAINT %I %s (%s)', t.relname, r.conname, r.conname, r.kind, r.cols);
    END LOOP;
    FOR r IN
      SELECT i.indexrelid::regclass AS idx, c.relname AS name, i.indisunique AS uniq, am.amname AS method,
             i.indkey[0] = t.num AND i.indnkeyatts > 1 AS rebuild,
             (SELECT string_agg('(' || pg_get_indexdef(i.indexrelid, n, true) || ')', ', ' ORDER BY n)
                FROM generate_series(2, i.indnkeyatts) n) AS cols,
             pg_get_expr(i.indpred, i.indrelid, true) AS pred
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
       WHERE i.indrelid = t.rel AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
         AND t.num = ANY(i.indkey::int2[])
    LOOP
      EXECUTE format('DROP INDEX %s', r.idx);
      IF r.rebuild THEN
        EXECUTE format('CREATE %s INDEX %I ON %I USING %s (%s)%s', CASE WHEN r.uniq THEN 'UNIQUE' ELSE '' END,
          r.name, t.relname, r.method, r.cols, COALESCE(' WHERE ' || r.pred, ''));
        IF r.name = ANY(constraint_keys) THEN
          EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE USING INDEX %I', t.relname, r.name, r.name);
        END IF;
      END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE %I DROP COLUMN tenant_id', t.relname);
  END LOOP;
  ALTER TABLE tenants DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;
  ${HOST_OBJECTS.join(";\n  ")};
  ALTER TABLE tenants DROP COLUMN IF EXISTS settings;
  DROP INDEX IF EXISTS deployments_name_lookup;
  DROP TRIGGER IF EXISTS acl_grants_truncate ON acl_grants;
  DROP TRIGGER IF EXISTS acl_grants_bump ON acl_grants;
  CREATE TRIGGER acl_grants_bump AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON acl_grants
    FOR EACH STATEMENT EXECUTE FUNCTION acl_grants_bump_version();

  FOR r IN SELECT conrelid::regclass AS tbl, conname, def FROM retired_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, r.def);
  END LOOP;
END $retire_tenant_keys$`,
      boundTenant,
    ],
  };
}

export const REPAIR_0116_CONSTRAINTS: PgMigrationDefinition = {
  id: "0000-tenancy/base/retire-0116-keys/repair",
  statements: [
    `DO $repair_0116$
DECLARE
  constraint_keys CONSTANT text[] := ARRAY[${CONSTRAINT_KEYS.map((name) => `'${name}'`).join(", ")}];
  n text;
  t regclass;
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id LIKE '%-tenants/1-column') THEN
    RETURN;
  END IF;
  FOREACH n IN ARRAY constraint_keys LOOP
    SELECT i.indrelid::regclass INTO t
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = n AND c.relnamespace = current_schema()::regnamespace AND i.indisunique
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid);
    IF t IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE USING INDEX %I', t, n, n);
    END IF;
  END LOOP;
  IF to_regclass('acl_grants') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('acl_grants') AND tgname = 'acl_grants_truncate') THEN
    DROP TRIGGER acl_grants_truncate ON acl_grants;
    DROP TRIGGER IF EXISTS acl_grants_bump ON acl_grants;
    CREATE TRIGGER acl_grants_bump AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON acl_grants
      FOR EACH STATEMENT EXECUTE FUNCTION acl_grants_bump_version();
  END IF;
END $repair_0116$`,
  ],
};
