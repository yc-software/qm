import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { isTenantId } from "../../src/tenants/context.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";

export function testTenants(): [string, string] {
  const ids = [process.env.QM_TEST_TENANT, process.env.QM_TEST_OTHER_TENANT];
  if (!ids.every(isTenantId)) throw new Error("QM_TEST_TENANT is unset: run tests through scripts/run-pg-tests.mjs");
  return ids as [string, string];
}

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

export function tenantBoundUrl(databaseUrl: string, tenant = testTenants()[0]): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get("options");
  url.searchParams.set("options", [options, `-c qm.tenant_id=${tenant}`].filter(Boolean).join(" "));
  return url.toString();
}
