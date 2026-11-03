import type { PgMigrationDefinition } from "./pg-pool.ts";
import { tenantTables } from "../tenants/migrations.ts";

export interface TypedTableSpec {
  table: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  backfill: Readonly<Record<string, string>>;
  indexes?: readonly string[];
  where?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function typedTableMigration(spec: TypedTableSpec): PgMigrationDefinition {
  const { table } = spec;
  if (!IDENTIFIER.test(table)) throw new Error(`invalid table name: ${table}`);
  const old = `${table}_kv`;
  const targets = Object.keys(spec.backfill);
  const primaryKey = spec.primaryKey.join(", ");
  const tenancy = tenantTables(`tenancy/${table}/0001-typed`, [{ table, primaryKey }], { after: spec.indexes ?? [] });
  return {
    id: tenancy.id,
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `ALTER TABLE ${table} RENAME TO ${old}`,
      `ALTER INDEX ${table}_pkey RENAME TO ${old}_pkey`,
      `CREATE TABLE ${table}(${[...spec.columns, `PRIMARY KEY (${primaryKey})`].join(", ")})`,
      `INSERT INTO ${table}(${targets.join(", ")})
         SELECT ${targets.map((column) => spec.backfill[column]).join(", ")} FROM ${old}${spec.where ? ` WHERE ${spec.where}` : ""}`,
      `DROP TABLE ${old}`,
      `DO $drop_version$ BEGIN
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = '${table}';
         END IF;
       END $drop_version$`,
      ...tenancy.statements,
    ],
  };
}
