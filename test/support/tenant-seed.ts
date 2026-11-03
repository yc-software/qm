import pg from "pg";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";

export async function seedInstallTenant(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const statement of TENANCY_BASE.statements) await client.query(statement);
    await client.query("INSERT INTO tenants DEFAULT VALUES");
  } finally {
    await client.end();
  }
}
