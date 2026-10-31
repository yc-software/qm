import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";
import { testTenants } from "./test-tenants.ts";

export async function seedTestTenants(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await applyPgMigrations(pool, [definePgMigration(TENANCY_BASE)]);
    for (const [index, id] of testTenants().entries()) {
      await pool.query("INSERT INTO tenants(id, slug, name) VALUES ($1, $2, $2)", [id, `test-${index}`]);
    }
  } finally {
    await pool.end();
  }
}

export async function recreateTenantSchema(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
  } finally {
    await pool.end();
  }
  await seedTestTenants(databaseUrl);
}
