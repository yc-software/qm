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

const TENANT_SETTINGS: PgMigrationDefinition = {
  id: "0000-tenancy/settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(settings) = 'object')`,
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

const TENANCY_EXPAND: readonly PgMigrationDefinition[] = [TENANCY_BASE, TENANT_SETTINGS, BOOT_TENANT];

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

export interface TenantExpansionOptions {
  references?: readonly TenantReference[];
  tenanted?: readonly string[];
}

const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

function tenantColumn(table: string): string {
  return `DO $tenant_column$
DECLARE
  existing uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants) THEN
    IF to_regclass('qm_tenant') IS NOT NULL THEN
      INSERT INTO tenants(id) SELECT id FROM qm_tenant;
    ELSE
      INSERT INTO tenants DEFAULT VALUES;
    END IF;
  END IF;
  SELECT id INTO existing FROM tenants ORDER BY created_at, id LIMIT 1;
  EXECUTE format('ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT %L', existing);
END $tenant_column$`;
}

function tenantKeys({ table, primaryKey, unique = [] }: TenantTable): string[] {
  const keys = unique.map(({ name, columns, where }) => ({ name: `${name}_tenant`, columns, where }));
  if (primaryKey !== undefined) keys.unshift({ name: `${table}_tenant_pkey`, columns: primaryKey, where: undefined });
  return keys.map(
    ({ name, columns, where }) =>
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table}(tenant_id, ${columns})${where ? ` WHERE ${where}` : ""}`,
  );
}

function deleteAction(columns: string, onDelete: TenantReference["onDelete"]): string {
  if (!onDelete) return "";
  return onDelete === "SET NULL" ? ` ON DELETE SET NULL (${columns})` : ` ON DELETE ${onDelete}`;
}

function addConstraint(table: string, name: string, also: string, definition: string): string {
  return `DO $tenant_reference$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'tenant_id'
     WHERE c.conrelid = '${table}'::regclass AND c.contype = 'f' AND c.conname IN ('${name}', '${also}')
       AND a.attnum = ANY (c.conkey)
  ) THEN
    ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition} NOT VALID;
  END IF;
END $tenant_reference$`;
}

function tenantForeignKey(table: string): string {
  return `${table}_tenant`;
}

function tenantReferenceName(name: string): string {
  return `${name}_tenant`;
}

function tenantReference({ table, name, columns, references, onDelete, deferrable }: TenantReference): string {
  return addConstraint(
    table,
    tenantReferenceName(name),
    name,
    `FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${deleteAction(columns, onDelete)}${deferrable ? " DEFERRABLE INITIALLY DEFERRED" : ""}`,
  );
}

export function tenantExpansion(
  id: string,
  tables: readonly TenantTable[],
  { references = [], tenanted = [] }: TenantExpansionOptions = {},
): PgMigrationDefinition[] {
  const keys = tables.flatMap(tenantKeys);
  const owners = [...tables.map(({ table }) => table), ...tenanted];
  return [
    ...TENANCY_EXPAND,
    { id: `${id}/0-column`, statements: [LOCK_TIMEOUT, ...tables.map(({ table }) => tenantColumn(table))] },
    ...(keys.length ? [{ id: `${id}/2-keys`, statements: keys }] : []),
    {
      id: `${id}/2-references`,
      statements: [
        LOCK_TIMEOUT,
        ...owners.map((table) =>
          addConstraint(
            table,
            tenantForeignKey(table),
            tenantForeignKey(table),
            "FOREIGN KEY (tenant_id) REFERENCES tenants(id)",
          ),
        ),
        ...references.map(tenantReference),
      ],
    },
  ];
}

export function inboundIndexes(table: string, fields: readonly string[] = []): PgMigrationDefinition {
  return {
    id: `tenancy/lookups/${table}-inbound-indexes`,
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_inbound_id ON ${table} (id)`,
      ...fields.map(
        (field) =>
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_inbound_${field.toLowerCase()}
            ON ${table} ((json->>'${field}')) WHERE json->>'${field}' IS NOT NULL`,
      ),
    ],
  };
}
