import pg from "pg";
import { DIRECTORY_MIGRATIONS } from "../../src/directory/postgres-directory-store.ts";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { SESSION_MIGRATIONS } from "../../src/sessions/session-schema.ts";
import { testTenants } from "./test-tenants.ts";

export async function seedTestTenants(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await applyPgMigrations(pool, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS].map(definePgMigration));
    const [tenant] = testTenants();
    await pool.query("UPDATE qm_tenant SET id = $1", [tenant]);
    await pool.query("UPDATE tenants SET id = $1", [tenant]);
  } finally {
    await pool.end();
  }
}
