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

export const SOLE_TENANT: PgMigrationDefinition = {
  id: "0000-tenancy/sole-tenant",
  statements: [
    `SET LOCAL check_function_bodies = off`,
    `CREATE OR REPLACE FUNCTION qm_sole_tenant(OUT sole uuid, OUT tenants bigint)
       LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $qm_sole_tenant$
       SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END, count(*) FROM tenants
     $qm_sole_tenant$`,
  ],
};

export const UNBOUND_SOLE_TENANT: PgMigrationDefinition = {
  id: "0000-tenancy/unbound-sole-tenant",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_bound_tenant() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE AS $qm_bound_tenant$
DECLARE
  bound text := current_setting('qm.tenant_id', true);
  sole uuid;
BEGIN
  IF bound IS NULL OR bound = '' THEN
    SELECT tenant.sole INTO sole FROM qm_sole_tenant() tenant;
    IF sole IS NULL THEN
      RAISE insufficient_privilege USING MESSAGE = 'No tenant is bound to this query';
    END IF;
    RETURN sole;
  END IF;
  RETURN bound::uuid;
END $qm_bound_tenant$`,
  ],
};

const SOLE_TENANT_SEARCH_PATH: PgMigrationDefinition = {
  id: "0000-tenancy/sole-tenant-search-path",
  statements: [
    `DO $sole_tenant_path$
BEGIN
  EXECUTE format('ALTER FUNCTION qm_sole_tenant() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $sole_tenant_path$`,
  ],
};

export const TENANCY: readonly PgMigrationDefinition[] = [
  TENANCY_BASE,
  SOLE_TENANT,
  UNBOUND_SOLE_TENANT,
  SOLE_TENANT_SEARCH_PATH,
];

export function tenantPolicies(table: string): string[] {
  return [
    `ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${table}
       USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`,
  ];
}

export const tenantColumn = (table: string): string => `DO $tenant_column$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ${table}) THEN
    ALTER TABLE ${table} ADD COLUMN tenant_id UUID NOT NULL;
    RETURN;
  END IF;
  INSERT INTO tenants(id) SELECT id FROM qm_tenant ON CONFLICT (id) DO NOTHING;
  EXECUTE format('ALTER TABLE ${table} ADD COLUMN tenant_id UUID NOT NULL DEFAULT %L', qm_tenant_id());
END $tenant_column$`;

interface TenantIndex {
  name: string;
  columns: string;
  where?: string;
  constraint?: boolean;
}

export interface TenantTable {
  table: string;
  primaryKey?: string;
  unique?: readonly TenantIndex[];
}

export interface TenantForeignKey {
  table: string;
  name: string;
  columns: string;
  references: string;
  onDelete?: "CASCADE";
}

function lookupIndexes({ table, primaryKey, unique = [] }: TenantTable): string[] {
  return [
    ...(primaryKey === undefined
      ? []
      : [`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_key_lookup ON ${table}(${primaryKey})`]),
    ...unique.map(
      ({ name, columns, where }) =>
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}_lookup ON ${table}(${columns})${where ? ` WHERE ${where}` : ""}`,
    ),
  ];
}

function typedTableStatements({ table, primaryKey, unique = [] }: TenantTable): string[] {
  return [
    tenantColumn(table),
    ...(primaryKey === undefined
      ? []
      : [`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey, ADD PRIMARY KEY (tenant_id, ${primaryKey})`]),
    ...unique.flatMap(({ name, columns, where, constraint }) => [
      constraint ? `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}` : `DROP INDEX IF EXISTS ${name}`,
      `CREATE UNIQUE INDEX ${name} ON ${table}(tenant_id, ${columns})${where ? ` WHERE ${where}` : ""}`,
    ]),
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
): PgMigrationDefinition[] {
  const lookups = tables.flatMap(lookupIndexes);
  const main = {
    id,
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      ...before,
      ...foreignKeys.map(({ table, name }) => `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`),
      ...tables.flatMap(typedTableStatements),
      ...foreignKeys.map(
        ({ table, name, columns, references, onDelete }) =>
          `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${onDelete ? ` ON DELETE ${onDelete}` : ""} NOT VALID`,
      ),
      ...after,
    ],
  };
  return lookups.length ? [main, { id: `${id}-lookups`, statements: lookups }] : [main];
}

export function createIfParentTenantKeyed(
  id: string,
  parent: string,
  table: string,
  create: string,
): PgMigrationDefinition {
  return {
    id,
    statements: [
      `DO $create_child$
BEGIN
  IF to_regclass('${table}') IS NULL AND EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('${parent}') AND attname = 'tenant_id'
  ) THEN
    ${create};
  END IF;
END $create_child$`,
    ],
  };
}

export const TENANT_HOSTS: PgMigrationDefinition = {
  id: "0001-tenancy/hosts-and-settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `SET LOCAL check_function_bodies = off`,
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

export const TENANT_HOSTS_SEARCH_PATH: PgMigrationDefinition = {
  id: "0001-tenancy/hosts-search-path",
  statements: [
    `DO $hosts_path$
BEGIN
  EXECUTE format('ALTER FUNCTION qm_host_tenant(text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION qm_tenant_settings() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $hosts_path$`,
  ],
};

export const TENANT_ROW_SECURITY: PgMigrationDefinition = {
  id: "0001-tenancy/tenant-row-security",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE tenants ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON tenants FOR SELECT USING (id = qm_bound_tenant())`,
    `ALTER TABLE tenant_hosts ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON tenant_hosts FOR SELECT USING (tenant_id = qm_bound_tenant())`,
    `DO $tenant_writes$
DECLARE
  grant_row record;
BEGIN
  FOR grant_row IN
    SELECT DISTINCT g.grantee, g.table_name FROM information_schema.role_table_grants g
      JOIN pg_class c ON c.oid = to_regclass(g.table_name)
     WHERE g.table_schema = current_schema() AND g.table_name IN ('tenants', 'tenant_hosts')
       AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       AND g.grantee <> pg_get_userbyid(c.relowner)
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM %I', grant_row.table_name, grant_row.grantee);
  END LOOP;
END $tenant_writes$`,
  ],
};
