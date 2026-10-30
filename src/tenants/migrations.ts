import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANT = "qm_tenant_id()";

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
];

export function tenantColumn(table: string): PgMigrationDefinition {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`invalid table name: ${table}`);
  return {
    id: `tenants/columns/${table}`,
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `DO $tenant_column$ BEGIN
         IF EXISTS (SELECT 1 FROM ${table}) AND (SELECT count(*) FROM tenants) <> 1 THEN
           RAISE 'Cannot backfill ${table}.tenant_id: existing rows need exactly one tenant';
         END IF;
         EXECUTE format('ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT %L REFERENCES tenants',
           CASE WHEN EXISTS (SELECT 1 FROM ${table}) THEN (SELECT id FROM tenants) END);
       END $tenant_column$`,
      `ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT qm_tenant_id()`,
    ],
  };
}
