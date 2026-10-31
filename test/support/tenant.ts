import { before } from "node:test";
import { configurePgPooling, createPgPool } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";
import { TENANT_HEADER } from "../../plugins/chassis/src/source-auth-sign.ts";
import { enterTenant } from "../../src/tenants/context.ts";
import { MEMORY_TENANT } from "../../src/tenants/resolver.ts";

export const TEST_TENANT = MEMORY_TENANT;
export const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
export const TENANT_HEADERS = { [TENANT_HEADER]: TEST_TENANT };

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
  if (url) before(() => ownTestDatabase(url));
}

async function ownTestDatabase(url: string): Promise<void> {
  configurePgPooling({ databaseUrl: url, ownerUrl: url });
  await seedTenant(url);
}

export function boundUrl(url: string, id = TEST_TENANT): string {
  const bound = new URL(url);
  const options = bound.searchParams.get("options");
  bound.searchParams.set("options", `${options ? `${options} ` : ""}-c qm.tenant_id=${id}`);
  return bound.toString();
}

export const TEST_ROOT_SCOPE = `org:${TEST_TENANT}`;

export async function provisionTestTenants(url: string): Promise<void> {
  configurePgPooling({ databaseUrl: url, ownerUrl: url });
  await seedTenant(url, TEST_TENANT);
  await seedTenant(url, OTHER_TENANT);
}
