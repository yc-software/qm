import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { TENANT_APP_HANDLES } from "./app-handle.ts";

const TENANCY_BASE: PgMigrationDefinition = {
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

const TENANT_SETTINGS: PgMigrationDefinition = {
  id: "0000-tenancy/settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(settings) = 'object')`,
  ],
};

const TENANT_ROW_SECURITY: PgMigrationDefinition = {
  id: "0000-tenancy/tenant-row-security",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE tenants ENABLE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_isolation ON tenants`,
    `CREATE POLICY tenant_isolation ON tenants FOR SELECT USING (id = qm_bound_tenant())`,
  ],
};

const BOOT_TENANT: PgMigrationDefinition = {
  id: "0000-tenancy/boot-tenant",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_boot_tenant() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public AS $qm_boot_tenant$
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END FROM (SELECT id FROM public.tenants LIMIT 2) one
    $qm_boot_tenant$`,
    `GRANT EXECUTE ON FUNCTION qm_boot_tenant() TO PUBLIC`,
  ],
};

const TENANT_HOSTS: PgMigrationDefinition = {
  id: "0000-tenancy/hosts",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS tenant_hosts(
      host TEXT PRIMARY KEY CHECK (host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
    )`,
    `ALTER TABLE tenant_hosts ENABLE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_isolation ON tenant_hosts`,
    `CREATE POLICY tenant_isolation ON tenant_hosts FOR SELECT USING (tenant_id = qm_bound_tenant())`,
    `CREATE OR REPLACE FUNCTION qm_tenant_for_host(name text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public AS $qm_tenant_for_host$
      SELECT tenant_id FROM public.tenant_hosts WHERE host = lower(name)
    $qm_tenant_for_host$`,
  ],
};

export const TENANCY: readonly PgMigrationDefinition[] = [
  TENANCY_BASE,
  TENANT_SETTINGS,
  TENANT_ROW_SECURITY,
  BOOT_TENANT,
  TENANT_HOSTS,
  TENANT_APP_HANDLES,
];

interface TenantKey {
  name: string;
  columns: string;
  where?: string;
  constraint?: boolean;
}

export interface TenantTable {
  table: string;
  primaryKey?: string;
  unique?: readonly TenantKey[];
}

interface TenantReference {
  table: string;
  name: string;
  columns: string;
  references: string;
  onDelete?: "CASCADE" | "SET NULL";
  deferrable?: boolean;
}

export interface TenantTableOptions {
  references?: readonly TenantReference[];
  before?: readonly string[];
  after?: readonly string[];
}

const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

function tenantColumn(table: string): string {
  return `DO $tenant_column$
DECLARE
  existing uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM ${table}) THEN
    IF NOT EXISTS (SELECT 1 FROM tenants) THEN
      INSERT INTO tenants DEFAULT VALUES;
    END IF;
    SELECT id INTO existing FROM tenants ORDER BY created_at, id LIMIT 1;
  END IF;
  EXECUTE format('ALTER TABLE ${table} ADD COLUMN tenant_id UUID NOT NULL DEFAULT %L', existing);
END $tenant_column$`;
}

export function tenantRowSecurity(table: string): string[] {
  return [
    `ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${table}
       USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`,
  ];
}

function tenantKeys({ table, primaryKey, unique = [] }: TenantTable): string[] {
  const keys = unique.map(({ name, columns, where }) => ({ name: `${name}_tenant`, columns, where }));
  if (primaryKey !== undefined) keys.unshift({ name: `${table}_tenant_pkey`, columns: primaryKey, where: undefined });
  return keys.map(
    ({ name, columns, where }) =>
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table}(tenant_id, ${columns})${where ? ` WHERE ${where}` : ""}`,
  );
}

function swapKeys({ table, primaryKey, unique = [] }: TenantTable): string[] {
  const primary =
    primaryKey === undefined
      ? []
      : [
          `ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey,
             ADD CONSTRAINT ${table}_pkey PRIMARY KEY USING INDEX ${table}_tenant_pkey`,
        ];
  return [
    ...primary,
    ...unique.flatMap(({ name, constraint }) =>
      constraint
        ? [`ALTER TABLE ${table} DROP CONSTRAINT ${name}, ADD CONSTRAINT ${name} UNIQUE USING INDEX ${name}_tenant`]
        : [`DROP INDEX ${name}`, `ALTER INDEX ${name}_tenant RENAME TO ${name}`],
    ),
  ];
}

function tenantReference({ table, name, columns, references, onDelete, deferrable }: TenantReference): string {
  const deleted = onDelete === "SET NULL" ? `SET NULL (${columns})` : onDelete;
  const action = deleted ? ` ON DELETE ${deleted}` : "";
  return `ALTER TABLE ${table} ADD CONSTRAINT ${name}
    FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${action}${deferrable ? " DEFERRABLE INITIALLY DEFERRED" : ""}`;
}

export function tenantTables(
  id: string,
  tables: readonly TenantTable[],
  { references = [], before = [], after = [] }: TenantTableOptions = {},
): PgMigrationDefinition[] {
  const keys = tables.flatMap(tenantKeys);
  return [
    ...TENANCY,
    { id: `${id}/1-column`, statements: [LOCK_TIMEOUT, ...before, ...tables.map(({ table }) => tenantColumn(table))] },
    ...(keys.length ? [{ id: `${id}/2-keys`, statements: keys }] : []),
    {
      id: `${id}/3-policy`,
      statements: [
        LOCK_TIMEOUT,
        ...references.map(({ table, name }) => `ALTER TABLE ${table} DROP CONSTRAINT ${name}`),
        ...tables.flatMap(swapKeys),
        ...references.map(tenantReference),
        ...tables.flatMap(({ table }) => tenantRowSecurity(table)),
        ...after,
      ],
    },
  ];
}
