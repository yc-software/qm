import type { Config } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

export async function instanceTenant(config: Pick<Config, "databaseUrl">): Promise<string | undefined> {
  if (!config.databaseUrl) return undefined;
  const db = createPgPool(config.databaseUrl);
  try {
    return String((await db.q("SELECT qm_tenant_id()::text AS id"))[0]!.id);
  } finally {
    await db.close();
  }
}
