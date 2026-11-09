import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

// Release 0.1.16 keyed every table by tenant_id first and added row security; this
// release is single-tenant. A database with those tenant-first keys is put back on the
// plain keys: tenant_id leaves every table except items and blobs, which keep it.
// Databases without tenant-first keys are left untouched.
export const RETIRE_TENANT_KEYS: PgMigrationDefinition = {
  id: "0000-tenancy/retire-tenant-keys",
  statements: [
    `SET LOCAL lock_timeout = '30s'`,
    `DO $retire_tenant_keys$
DECLARE
  kept CONSTANT text[] := ARRAY['items', 'blobs'];
  registry CONSTANT text[] := ARRAY['tenants', 'tenant_hosts', 'retired_tenant_hosts'];
  t record;
  r record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint k
     WHERE k.contype = 'p' AND k.connamespace = current_schema()::regnamespace
       AND pg_get_constraintdef(k.oid) LIKE 'PRIMARY KEY (tenant_id, %'
       AND NOT k.conrelid::regclass::text = ANY(kept || registry)
  ) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM tenants) > 1 THEN
    RAISE EXCEPTION 'This database holds % tenants. This release is single-tenant and cannot open it.',
      (SELECT count(*) FROM tenants);
  END IF;

  CREATE TEMP TABLE retired_tenant_fks ON COMMIT DROP AS
    SELECT k.conrelid::regclass AS tbl, k.conname,
           regexp_replace(regexp_replace(pg_get_constraintdef(k.oid), '\\(tenant_id, ', '(', 'g'), ' NOT VALID$', '') AS def
      FROM pg_constraint k
     WHERE k.contype = 'f' AND k.connamespace = current_schema()::regnamespace
       AND pg_get_constraintdef(k.oid) LIKE 'FOREIGN KEY (tenant_id, %'
       AND NOT k.confrelid::regclass::text = ANY(kept);
  FOR r IN
    SELECT k.conrelid::regclass AS tbl, k.conname FROM pg_constraint k
     WHERE k.contype = 'f' AND k.connamespace = current_schema()::regnamespace
       AND NOT k.conrelid::regclass::text = ANY(registry)
       AND (pg_get_constraintdef(k.oid) LIKE 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)%'
            OR (pg_get_constraintdef(k.oid) LIKE 'FOREIGN KEY (tenant_id, %' AND NOT k.confrelid::regclass::text = ANY(kept)))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;

  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
     WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND NOT c.relname = ANY(registry)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.relname);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY', t.relname);
    IF t.relname = ANY(kept) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t.relname);
      CONTINUE;
    END IF;
    FOR r IN
      SELECT k.conname, k.contype, regexp_replace(pg_get_constraintdef(k.oid), '\\(tenant_id, ', '(') AS def
        FROM pg_constraint k
       WHERE k.conrelid = t.oid AND k.contype IN ('p', 'u') AND pg_get_constraintdef(k.oid) LIKE '% (tenant_id, %'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I, ADD CONSTRAINT %I %s', t.relname, r.conname, r.conname, r.def);
    END LOOP;
    FOR r IN
      SELECT i.indexrelid::regclass AS idx, pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i
       WHERE i.indrelid = t.oid
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
         AND pg_get_indexdef(i.indexrelid) ~ '\\mtenant_id\\M'
    LOOP
      EXECUTE format('DROP INDEX %s', r.idx);
      IF r.def ~ '\\(tenant_id, ' THEN
        EXECUTE regexp_replace(r.def, '\\(tenant_id, ', '(');
      END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE %I DROP COLUMN tenant_id', t.relname);
  END LOOP;

  ALTER TABLE tenants DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;

  FOR r IN SELECT tbl, conname, def FROM retired_tenant_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, r.def);
  END LOOP;
END $retire_tenant_keys$`,
  ],
};
