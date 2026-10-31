import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANCY_BASE: PgMigrationDefinition = {
  id: "0000-tenancy/base",
  statements: [
    `DO $refuse_tenant_roles$
BEGIN
  IF current_user IN ('qm_app', 'qm_reader') THEN
    RAISE EXCEPTION 'Run migrations as the database owner, not as %', current_user USING ERRCODE = 'insufficient_privilege';
  END IF;
END $refuse_tenant_roles$`,
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
    `DO $tenant_roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['qm_app', 'qm_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS', role_name);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
      END;
    END IF;
  END LOOP;
END $tenant_roles$`,
    `DO $tenant_grants$
DECLARE
  grant_sql text;
BEGIN
  FOREACH grant_sql IN ARRAY ARRAY[
    format('GRANT USAGE ON SCHEMA %I TO qm_app, qm_reader', current_schema()),
    format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO qm_app', current_schema()),
    format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO qm_app', current_schema()),
    format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO qm_reader', current_schema()),
    format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app', current_schema()),
    format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO qm_app', current_schema()),
    format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO qm_reader', current_schema()),
    'REVOKE INSERT, UPDATE, DELETE ON tenants, qm_schema_migrations FROM qm_app',
    'GRANT SELECT ON tenants, qm_schema_migrations TO qm_app, qm_reader'
  ] LOOP
    BEGIN
      EXECUTE grant_sql;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'Skipped tenant grant the host refused: %', grant_sql;
    END;
  END LOOP;
END $tenant_grants$`,
  ],
};

export function tenantTableStatements(table: string): string[] {
  return [
    `ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_app ON ${table} FOR ALL TO qm_app
       USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`,
    `CREATE POLICY tenant_reader ON ${table} FOR SELECT TO qm_reader USING (tenant_id = qm_bound_tenant())`,
  ];
}
