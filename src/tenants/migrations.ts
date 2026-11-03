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

export const TENANCY: readonly PgMigrationDefinition[] = [TENANCY_BASE, SOLE_TENANT, UNBOUND_SOLE_TENANT];

export function tenantPolicies(table: string): string[] {
  return [
    `ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
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
