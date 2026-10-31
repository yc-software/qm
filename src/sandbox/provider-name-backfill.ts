import type { Config } from "../config.ts";
import { createPgPool, PG_MIGRATIONS_TABLE } from "../persistence/pg-pool.ts";
import { swallowAs } from "../util/errors.ts";
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

const MARKER = "sandbox/provider-names";

export async function backfillProviderNames(config: Config): Promise<number> {
  if (!config.databaseUrl) return 0;
  const prefixes = {
    sprites: config.spritesSandbox.namePrefix ?? "qm",
    smolmachines: config.smolmachinesSandbox.namePrefix ?? "qm",
  };
  const db = createPgPool(config.databaseUrl);
  const client = await (await db.pool()).connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MARKER]);
    if ((await client.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [MARKER])).rowCount) return 0;
    let named = 0;
    for (const [backend, prefix] of Object.entries(prefixes)) {
      const { rows } = await client.query<{ tenant_id: string; id: string; backing_scope_id: string }>(
        "SELECT tenant_id, id, backing_scope_id FROM sandbox_resources WHERE backend = $1 AND provider_name IS NULL",
        [backend],
      );
      const updated = await client.query(
        `UPDATE sandbox_resources r SET provider_name = n.name
           FROM unnest($1::uuid[], $2::text[], $3::text[]) AS n(tenant_id, id, name)
          WHERE r.tenant_id = n.tenant_id AND r.id = n.id AND r.provider_name IS NULL`,
        [
          rows.map((r) => r.tenant_id),
          rows.map((r) => r.id),
          rows.map((r) => legacyScopeName(prefix, r.backing_scope_id)),
        ],
      );
      named += updated.rowCount ?? 0;
    }
    await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $1)`, [MARKER]);
    console.log(`[qm:migrate] stored provider names for ${named} existing computers`);
    return named;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [MARKER])
      .catch(swallowAs("provider names: unlock", undefined));
    client.release();
    await db.close();
  }
}
