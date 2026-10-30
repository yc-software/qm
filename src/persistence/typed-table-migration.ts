import type { PgMigrationDefinition } from "./pg-pool.ts";
import { tenantPolicies } from "../tenants/migrations.ts";

export interface TypedTableSpec {
  table: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  backfill: Readonly<Record<string, string>>;
  indexes?: readonly string[];
  constraints?: readonly string[];
  where?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function typedTableMigration(spec: TypedTableSpec): PgMigrationDefinition {
  const { table } = spec;
  if (!IDENTIFIER.test(table)) throw new Error(`invalid table name: ${table}`);
  const old = `${table}_kv`;
  const targets = Object.keys(spec.backfill);
  return {
    id: `tenancy/${table}/0001-typed`,
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `ALTER TABLE ${table} RENAME TO ${old}`,
      `ALTER INDEX ${table}_pkey RENAME TO ${old}_pkey`,
      `CREATE TABLE ${table}(
         tenant_id UUID NOT NULL DEFAULT qm_tenant_id() REFERENCES tenants,
         ${[...spec.columns, ...(spec.constraints ?? []), `PRIMARY KEY (tenant_id, ${spec.primaryKey.join(", ")})`].join(",\n         ")}
       )`,
      `INSERT INTO ${table}(tenant_id, ${targets.join(", ")})
         SELECT (SELECT id FROM tenants), ${targets.map((column) => spec.backfill[column]).join(", ")} FROM ${old}${spec.where ? ` WHERE ${spec.where}` : ""}`,
      `DROP TABLE ${old}`,
      `DO $drop_version$ BEGIN
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = '${table}';
         END IF;
       END $drop_version$`,
      ...(spec.indexes ?? []),
      ...tenantPolicies(table),
    ],
  };
}
