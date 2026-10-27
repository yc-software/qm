import pg from "pg";
import { tableCodec, type TableSpec } from "../../src/persistence/typed-table.ts";
import { testDatabaseUrl } from "./test-database.ts";

export { migrate } from "./migrations.ts";

export const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run migration tests";

export async function withMigratedDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const url = testDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url });
  try {
    await run(url, admin);
  } finally {
    await admin.end();
  }
}

export async function typedRows<T = Record<string, unknown>>(pool: pg.Pool, spec: TableSpec) {
  const codec = tableCodec<Record<string, unknown>>(spec);
  const found = await pool.query(`SELECT ${codec.columns} FROM ${spec.table}`);
  return Object.fromEntries(codec.rows(found.rows).map((row) => [row[spec.key], row])) as Record<string, T>;
}

export async function asMapTables(pool: pg.Pool, specs: readonly TableSpec[]) {
  for (const { table } of specs) {
    await pool.query(`DROP TABLE ${table}`);
    await pool.query(`DELETE FROM qm_schema_migrations WHERE id = ANY($1)`, [
      [`typed/config/${table}/0001`, `contract/typed/config/${table}/0001`],
    ]);
  }
}
