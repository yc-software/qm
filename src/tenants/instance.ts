import type { Config } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

const NO_DATABASE_TENANT = "00000000-0000-4000-8000-000000000000";

export async function instanceTenant(
  config: Pick<Config, "databaseUrl" | "sessionStore">,
): Promise<string | undefined> {
  if (!config.databaseUrl) return NO_DATABASE_TENANT;
  if (config.sessionStore !== "postgres") return undefined;
  const db = createPgPool(config.databaseUrl);
  try {
    const rows = await db.q("SELECT id::text AS id FROM tenants");
    if (rows.length !== 1) throw new Error(`Expected exactly one tenant in this database, found ${rows.length}`);
    return String(rows[0]!.id);
  } finally {
    await db.close();
  }
}
