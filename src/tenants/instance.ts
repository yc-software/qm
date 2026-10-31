import type { Config } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

export async function instanceTenant(
  config: Pick<Config, "databaseUrl" | "sessionStore">,
): Promise<string | undefined> {
  if (config.sessionStore !== "postgres" || !config.databaseUrl) return undefined;
  const db = createPgPool(config.databaseUrl);
  try {
    const rows = await db.q("SELECT id::text AS id FROM tenants");
    if (rows.length !== 1) throw new Error(`Expected exactly one tenant in this database, found ${rows.length}`);
    return String(rows[0]!.id);
  } finally {
    await db.close();
  }
}
