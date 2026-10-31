import { randomUUID } from "node:crypto";
import { createPgPool, ownerDatabaseUrl, withPgTransaction } from "../persistence/pg-pool.ts";

export class UnknownTenant extends Error {
  readonly slug: string;
  readonly existing: string[];
  constructor(slug: string, existing: string[]) {
    super(`No tenant has the slug ${slug}; this database has ${existing.join(", ")}`);
    this.slug = slug;
    this.existing = existing;
  }
}

export const validTenantSlug = (slug: unknown): slug is string =>
  typeof slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);

export async function ensureInstallTenant(
  databaseUrl: string,
  slug: string,
): Promise<{ tenant: string; created: boolean }> {
  const db = createPgPool(ownerDatabaseUrl(databaseUrl));
  try {
    return await withPgTransaction(await db.pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:install-tenant'))");
      const inserted = await client.query(
        `INSERT INTO tenants(id, slug, name) SELECT $1, $2, $2 WHERE NOT EXISTS (SELECT 1 FROM tenants)`,
        [randomUUID(), slug],
      );
      const { rows } = await client.query("SELECT id::text AS id, slug FROM tenants ORDER BY slug");
      const match = rows.find((row) => row.slug === slug);
      if (!match)
        throw new UnknownTenant(
          slug,
          rows.map((row) => String(row.slug)),
        );
      return { tenant: String(match.id), created: inserted.rowCount === 1 };
    });
  } finally {
    await db.close();
  }
}
