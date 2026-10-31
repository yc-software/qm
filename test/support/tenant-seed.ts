import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
export const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

export async function seedTenant(url: string, id = TEST_TENANT): Promise<void> {
  const db = createPgPool(url, [TENANCY_BASE]);
  try {
    await db.q(`INSERT INTO tenants(id, slug, name) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [
      id,
      `t-${id.slice(-12)}`,
    ]);
  } finally {
    await db.close();
  }
}

export async function seedTestTenants(url: string): Promise<void> {
  await seedTenant(url, TEST_TENANT);
  await seedTenant(url, OTHER_TENANT);
}
