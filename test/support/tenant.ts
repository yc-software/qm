import pg from "pg";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { enterTenant } from "../../src/tenants/context.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
export const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

export function bindTestTenant(): void {
  enterTenant(TEST_TENANT);
}

export async function provisionTestTenants(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    if (!(await pool.query("SELECT to_regclass('tenants') AS t")).rows[0].t) {
      const sessions = createPostgresSessionStore(url);
      await migrateRegisteredPgSchemas(url);
      await sessions.close?.();
    }
    await pool.query(
      `INSERT INTO tenants(id, slug, name) VALUES ($1, 'test-tenant', 'Test'), ($2, 'other-tenant', 'Other')
       ON CONFLICT DO NOTHING`,
      [TEST_TENANT, OTHER_TENANT],
    );
  } finally {
    await pool.end();
  }
}
