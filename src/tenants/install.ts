import { randomUUID } from "node:crypto";
import { createPgPool, ownerDatabaseUrl } from "../persistence/pg-pool.ts";

export const validTenantSlug = (slug: unknown): slug is string =>
  typeof slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);

export async function ensureInstallTenant(
  databaseUrl: string,
  slug: string,
): Promise<{ tenant: string; created: boolean }> {
  const db = createPgPool(ownerDatabaseUrl(databaseUrl));
  try {
    const inserted = await db.q(
      `INSERT INTO tenants(id, slug, name) VALUES ($1, $2, $2) ON CONFLICT (slug) DO NOTHING RETURNING id::text AS id`,
      [randomUUID(), slug],
    );
    const rows = await db.q("SELECT id::text AS id FROM tenants WHERE slug = $1", [slug]);
    return { tenant: String(rows[0]!.id), created: inserted.length === 1 };
  } finally {
    await db.close();
  }
}
