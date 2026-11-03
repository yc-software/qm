import { createPgPool, ownerDatabaseUrl } from "../persistence/pg-pool.ts";

export async function createTenant(databaseUrl: string, tenant: string): Promise<{ tenant: string; created: boolean }> {
  const db = createPgPool(ownerDatabaseUrl(databaseUrl));
  try {
    const { rowCount } = await (
      await db.pool()
    ).query("INSERT INTO tenants(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [tenant]);
    return { tenant, created: rowCount === 1 };
  } finally {
    await db.close();
  }
}
