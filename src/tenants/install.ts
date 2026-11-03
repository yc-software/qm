import { randomUUID } from "node:crypto";
import { createPgPool, ownerDatabaseUrl, withPgTransaction } from "../persistence/pg-pool.ts";

export class AmbiguousInstallTenant extends Error {
  readonly tenants: string[];
  constructor(tenants: string[]) {
    super(`This database has ${tenants.length} tenants; an install holds exactly one`);
    this.tenants = tenants;
  }
}

export async function ensureInstallTenant(databaseUrl: string): Promise<{ tenant: string; created: boolean }> {
  const db = createPgPool(ownerDatabaseUrl(databaseUrl));
  try {
    return await withPgTransaction(await db.pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:install-tenant'))");
      const inserted = await client.query(
        "INSERT INTO tenants(id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM tenants)",
        [randomUUID()],
      );
      const { rows } = await client.query("SELECT id::text AS id FROM tenants ORDER BY id");
      if (rows.length !== 1) throw new AmbiguousInstallTenant(rows.map((row) => String(row.id)));
      return { tenant: String(rows[0]!.id), created: inserted.rowCount === 1 };
    });
  } finally {
    await db.close();
  }
}
