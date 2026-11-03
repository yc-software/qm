import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANCY_BASE: PgMigrationDefinition = {
  id: "0000-tenancy/base",
  statements: [
    `CREATE TABLE IF NOT EXISTS tenants(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

export const TENANT_HOSTS: PgMigrationDefinition = {
  id: "0001-tenancy/hosts-and-settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS tenant_hosts(
      host TEXT PRIMARY KEY CHECK (host = lower(host) AND host <> ''),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS tenant_hosts_tenant ON tenant_hosts(tenant_id)`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(settings) = 'object')`,
    `CREATE OR REPLACE FUNCTION qm_host_tenant(requested text) RETURNS TABLE(tenant_id uuid, multi boolean)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $qm_host_tenant$
      SELECT (SELECT h.tenant_id FROM tenant_hosts h WHERE h.host = lower(requested)), EXISTS (SELECT 1 FROM tenant_hosts)
    $qm_host_tenant$`,
    `CREATE OR REPLACE FUNCTION qm_tenant_settings() RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $qm_tenant_settings$
      SELECT settings FROM tenants WHERE id = qm_bound_tenant()
    $qm_tenant_settings$`,
  ],
};
