import { definePgMigration, PG_MIGRATIONS_TABLE, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { REPAIR_0116_CONSTRAINTS, RETIRE_0116_HOSTS, retire0116Tenancy } from "./retire-0116-tenancy.ts";
import {
  TENANT_APP_HANDLE_DNS_BOUND,
  TENANT_APP_HANDLES,
  TENANT_APP_HOSTS_BY_HANDLE,
  TENANT_APP_HOSTS_LEGACY_NAMES,
} from "./app-handle.ts";

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

const LEGACY_TENANT: PgMigrationDefinition = {
  id: "0000-tenancy/legacy-tenant",
  statements: [
    `DO $legacy_tenant$
BEGIN
  IF to_regclass('qm_tenant') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenants) THEN
    INSERT INTO tenants(id) SELECT id FROM qm_tenant;
  END IF;
END $legacy_tenant$`,
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
  id: "0000-tenancy/boot-tenant-function",
  statements: [
    `CREATE OR REPLACE FUNCTION qm_boot_tenant() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public AS $qm_boot_tenant$
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END FROM (SELECT id FROM public.tenants LIMIT 2) one
    $qm_boot_tenant$`,
  ],
};

const SERVING_TENANTS: PgMigrationDefinition = {
  id: "0000-tenancy/serving-tenants-function",
  statements: [
    `DO $serving$ BEGIN EXECUTE format($sql$CREATE OR REPLACE FUNCTION qm_serving_tenants() RETURNS SETOF uuid
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = %1$I, pg_temp AS $f$
      BEGIN
        RETURN QUERY SELECT id FROM tenants
          WHERE settings->>'serving' IS DISTINCT FROM 'false' OR qm_boot_tenant() IS NOT NULL;
      END $f$$sql$, current_schema()); END $serving$`,
  ],
};

export const TENANCY: readonly PgMigrationDefinition[] = [
  TENANCY_BASE,
  retire0116Tenancy(TENANCY_BASE.statements[1]!),
  REPAIR_0116_CONSTRAINTS,
  LEGACY_TENANT,
  TENANT_SETTINGS,
  TENANT_ROW_SECURITY,
  BOOT_TENANT,
  TENANT_APP_HANDLES,
  RETIRE_0116_HOSTS,
  TENANT_APP_HANDLE_DNS_BOUND,
  TENANT_APP_HOSTS_BY_HANDLE,
  TENANT_APP_HOSTS_LEGACY_NAMES,
  SERVING_TENANTS,
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
  tenanted?: readonly string[];
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

function deleteAction(columns: string, onDelete: TenantReference["onDelete"]): string {
  if (!onDelete) return "";
  return onDelete === "SET NULL" ? ` ON DELETE SET NULL (${columns})` : ` ON DELETE ${onDelete}`;
}

function tenantReference({ table, name, columns, references, onDelete, deferrable }: TenantReference): string {
  return `ALTER TABLE ${table} ADD CONSTRAINT ${name}
    FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${deleteAction(columns, onDelete)}${deferrable ? " DEFERRABLE INITIALLY DEFERRED" : ""}`;
}

const TENANCY_EXPAND: readonly PgMigrationDefinition[] = [TENANCY_BASE, TENANT_SETTINGS, BOOT_TENANT];

function expandColumn(table: string): string {
  return `DO $tenant_column$
DECLARE
  existing uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM ${table}) THEN
    IF to_regclass('qm_tenant') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenants) THEN
      INSERT INTO tenants(id) SELECT id FROM qm_tenant;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenants) THEN
      INSERT INTO tenants DEFAULT VALUES;
    END IF;
    SELECT id INTO existing FROM tenants ORDER BY created_at, id LIMIT 1;
  END IF;
  EXECUTE format('ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT %L', existing);
END $tenant_column$`;
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

function unvalidatedReference({ table, name, columns, references, onDelete, deferrable }: TenantReference): string {
  return addConstraint(
    table,
    tenantReferenceName(name),
    name,
    `FOREIGN KEY (tenant_id, ${columns}) REFERENCES ${references}${deleteAction(columns, onDelete)}${deferrable ? " DEFERRABLE INITIALLY DEFERRED" : ""}`,
  );
}

function tenantExpansion(
  id: string,
  tables: readonly TenantTable[],
  { references = [], tenanted = [] }: Pick<TenantTableOptions, "references" | "tenanted">,
): PgMigrationDefinition[] {
  const keys = tables.flatMap(tenantKeys);
  const owners = [...tables.map(({ table }) => table), ...tenanted];
  return [
    ...TENANCY_EXPAND,
    { id: `${id}/0-column`, statements: [LOCK_TIMEOUT, ...tables.map(({ table }) => expandColumn(table))] },
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
        ...references.map(unvalidatedReference),
      ],
    },
  ];
}

const TENANT_REFERENCE_ADD =
  /^ALTER TABLE (\w+) ADD CONSTRAINT (\w+) FOREIGN KEY \(tenant_id\) REFERENCES tenants\(id\)$/;
const COMPOSITE_REFERENCE_ADD = /^ALTER TABLE (\w+) ADD CONSTRAINT (\w+)\s+FOREIGN KEY \(tenant_id, /;

function adoptedStatements(policy: readonly string[]): string[] {
  const validations: string[] = [];
  const rest = policy.flatMap((statement) => {
    const tenantReference = TENANT_REFERENCE_ADD.exec(statement);
    if (tenantReference) {
      validations.push(`ALTER TABLE ${tenantReference[1]} VALIDATE CONSTRAINT ${tenantReference[2]}`);
      return [];
    }
    const composite = COMPOSITE_REFERENCE_ADD.exec(statement);
    if (composite) {
      const [, table, name] = composite;
      validations.push(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${tenantReferenceName(name!)}`);
      return [`ALTER TABLE ${table} RENAME CONSTRAINT ${tenantReferenceName(name!)} TO ${name}`];
    }
    if (/\bFOREIGN KEY\b/.test(statement) && /\bADD CONSTRAINT\b/.test(statement)) {
      throw new Error(`tenancy: cannot adopt an unprepared foreign key: ${statement.slice(0, 120)}`);
    }
    return [statement];
  });
  return [...validations, ...rest];
}

function ledgerRow(migration: PgMigrationDefinition): string {
  const { id, checksum } = definePgMigration(migration);
  return `INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ('${id}', '${checksum}') ON CONFLICT (id) DO NOTHING`;
}

const QUOTE = "$tenant_statement$";

function adoptPolicy(id: string, policy: PgMigrationDefinition, before: readonly string[]): PgMigrationDefinition {
  const statements = [...before, ...adoptedStatements(policy.statements)];
  for (const statement of statements) {
    if (statement.includes(QUOTE)) throw new Error(`tenancy: statement in ${policy.id} uses the reserved quote`);
  }
  return {
    id,
    statements: [
      `DO $adopt_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = '${policy.id}') THEN
    RETURN;
  END IF;
${statements.map((statement) => `  EXECUTE ${QUOTE}${statement}${QUOTE};`).join("\n")}
  ${ledgerRow(policy)};
END $adopt_policy$`,
    ],
  };
}

export function tenantTables(
  id: string,
  tables: readonly TenantTable[],
  { references = [], tenanted = [], before = [], after = [] }: TenantTableOptions = {},
): PgMigrationDefinition[] {
  const keys = tables.flatMap(tenantKeys);
  const column = {
    id: `${id}/1-column`,
    statements: [LOCK_TIMEOUT, ...before, ...tables.map(({ table }) => tenantColumn(table))],
  };
  const policy = {
    id: `${id}/3-policy`,
    statements: [
      LOCK_TIMEOUT,
      ...references.map(({ table, name }) => `ALTER TABLE ${table} DROP CONSTRAINT ${name}`),
      ...tables.flatMap(swapKeys),
      ...references.map(tenantReference),
      ...tables.flatMap(({ table }) => tenantRowSecurity(table)),
      ...after,
    ],
  };
  return [
    ...tenantExpansion(id, tables, { references, tenanted }),
    { id: `${id}/0-stamp-column`, statements: [ledgerRow(column)] },
    ...TENANCY,
    column,
    ...(keys.length ? [{ id: `${id}/2-keys`, statements: keys }] : []),
    adoptPolicy(`${id}/2-tenant-policy`, policy, before),
    policy,
  ];
}
