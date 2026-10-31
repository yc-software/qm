import type { Config } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { shortHash } from "../util/crypto.ts";

const MAX_NAME = 63;
const HASH_LEN = 6;

function legacyScopeName(prefix: string, id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `${prefix}-${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
  if (name.length <= MAX_NAME) return name;
  const hash = shortHash(name);
  const slugBudget = MAX_NAME - prefix.length - HASH_LEN - 2;
  const slug = slugBudget > 0 ? cleaned.slice(0, slugBudget).replace(/-+$/, "") : "";
  if (slug) return `${prefix}-${slug}-${hash}`;
  const head = prefix.slice(0, MAX_NAME - HASH_LEN - 1).replace(/-+$/, "");
  return head ? `${head}-${hash}` : hash;
}

export async function backfillProviderNames(config: Config): Promise<number> {
  if (!config.databaseUrl) return 0;
  const prefixes = {
    sprites: config.spritesSandbox.namePrefix ?? "qm",
    smolmachines: config.smolmachinesSandbox.namePrefix ?? "qm",
  };
  const db = createPgPool(config.databaseUrl);
  try {
    let named = 0;
    for (const [backend, prefix] of Object.entries(prefixes)) {
      const rows = await db.q(
        "SELECT tenant_id, id, backing_scope_id FROM sandbox_resources WHERE backend = $1 AND provider_name IS NULL",
        [backend],
      );
      for (const row of rows) {
        await db.q(
          "UPDATE sandbox_resources SET provider_name = $1 WHERE tenant_id = $2 AND id = $3 AND provider_name IS NULL",
          [legacyScopeName(prefix, String(row.backing_scope_id)), row.tenant_id, row.id],
        );
        named++;
      }
    }
    if (named) console.log(`[qm:migrate] stored provider names for ${named} existing computers`);
    return named;
  } finally {
    await db.close();
  }
}
