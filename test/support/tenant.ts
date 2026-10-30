import { before } from "node:test";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";
import { enterTenant } from "../../src/tenants/context.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";

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

export function bindTestTenant(): void {
  enterTenant(TEST_TENANT);
  const url = process.env.DATABASE_URL;
  if (url) before(() => seedTenant(url));
}
