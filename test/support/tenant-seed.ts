import pg from "pg";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";

const TEST_INSTALL_TENANT = "00000000-0000-4000-8000-000000000001";

export async function seedInstallTenant(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const statement of TENANCY_BASE.statements) await client.query(statement);
    await client.query("INSERT INTO tenants(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [TEST_INSTALL_TENANT]);
  } finally {
    await client.end();
  }
}
