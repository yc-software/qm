import { randomUUID } from "node:crypto";
import { createPgPool, ownerDatabaseUrl } from "../persistence/pg-pool.ts";

export async function ensureInstallTenant(databaseUrl: string): Promise<{ tenant: string; created: boolean }> {
  const db = createPgPool(ownerDatabaseUrl(databaseUrl));
  try {
    const inserted = await db.q(
      `INSERT INTO tenants(id, slug, name) SELECT $1, 'main', 'Main' WHERE NOT EXISTS (SELECT 1 FROM tenants)
       ON CONFLICT (slug) DO NOTHING RETURNING id::text AS id`,
      [randomUUID()],
    );
    const rows = await db.q("SELECT id::text AS id FROM tenants ORDER BY (slug = 'main') DESC, created_at, id LIMIT 1");
    return { tenant: String(rows[0]!.id), created: inserted.length === 1 };
  } finally {
    await db.close();
  }
}
