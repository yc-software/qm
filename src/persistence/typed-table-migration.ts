import type { PgMigrationDefinition } from "./pg-pool.ts";
import { tenantTables } from "../tenants/migrations.ts";

export interface TypedTableSpec {
  table: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  backfill: Readonly<Record<string, string>>;
  where?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const dropDurableMapVersions = (tables: readonly string[]): string => `DO $drop_versions$ BEGIN
  IF to_regclass('durable_map_versions') IS NOT NULL THEN
    DELETE FROM durable_map_versions WHERE tbl IN (${tables.map((table) => `'${table}'`).join(", ")});
  END IF;
END $drop_versions$`;

export function typedTableMigration(spec: TypedTableSpec): PgMigrationDefinition {
  const { table } = spec;
  if (!IDENTIFIER.test(table)) throw new Error(`invalid table name: ${table}`);
  const old = `${table}_kv`;
  const targets = Object.keys(spec.backfill);
  return tenantTables(`tenancy/${table}/0001-typed`, [{ table, primaryKey: spec.primaryKey.join(", ") }], {
    before: [
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `ALTER TABLE ${table} RENAME TO ${old}`,
      `ALTER INDEX ${table}_pkey RENAME TO ${old}_pkey`,
      `CREATE TABLE ${table}(${[...spec.columns, `PRIMARY KEY (${spec.primaryKey.join(", ")})`].join(", ")})`,
      `INSERT INTO ${table}(${targets.join(", ")})
         SELECT ${targets.map((column) => spec.backfill[column]).join(", ")} FROM ${old}${spec.where ? ` WHERE ${spec.where}` : ""}`,
      `DROP TABLE ${old}`,
      dropDurableMapVersions([table]),
    ],
  });
}
