import type { PoolClient } from "pg";
import type { ScopeId } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { createNotebookMemory, type FactStoreTx, type MemoryService } from "./memory-service.ts";
import { isMemorySensitivity, type MemoryFact } from "./facts.ts";

/**
 * Also registered by the vector store, which reads text_hash: the pool that runs first adds the
 * column either way.
 */
const TEXT_HASH_FUNCTION = `CREATE OR REPLACE FUNCTION memory_facts_text_hash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.text_hash := encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex');
        RETURN NEW;
      END $$`;

export const MEMORY_FACTS_MIGRATIONS = [
  {
    // The embedding index keys vectors by this hash; a trigger keeps it in step with text on every write path.
    id: "memory/facts/0002-text-hash",
    statements: [
      "ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS text_hash TEXT",
      TEXT_HASH_FUNCTION,
      "DROP TRIGGER IF EXISTS memory_facts_text_hash ON memory_facts",
      `CREATE TRIGGER memory_facts_text_hash BEFORE INSERT OR UPDATE OF text ON memory_facts
        FOR EACH ROW EXECUTE FUNCTION memory_facts_text_hash()`,
      "UPDATE memory_facts SET text_hash = encode(sha256(convert_to(text, 'UTF8')), 'hex') WHERE text_hash IS NULL",
      "ALTER TABLE memory_facts ALTER COLUMN text_hash SET NOT NULL",
    ],
    expectedChecksum: "c7ca6a779272265e9201ccf0430ec1ca98836701b2eff508b08af22e008aadb5",
    // The first release of this id lacked SET NOT NULL; 0003 finishes those databases.
    acceptedChecksums: ["3548fb7774545aa8d6ce9ab89eba26c8f4817b7865bb5b6d839011b52ea39a1e"],
  },
  {
    id: "memory/facts/0003-text-hash-not-null",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "UPDATE memory_facts SET text_hash = encode(sha256(convert_to(text, 'UTF8')), 'hex') WHERE text_hash IS NULL",
      "ALTER TABLE memory_facts ALTER COLUMN text_hash SET NOT NULL",
    ],
  },
  { id: "memory/facts/0004-text-hash-function", statements: [TEXT_HASH_FUNCTION] },
];

type Row = Record<string, unknown>;

function fact(row: Row): MemoryFact {
  const sensitivity = row.sensitivity;
  return {
    id: String(row.id),
    text: String(row.text),
    sensitivity: isMemorySensitivity(sensitivity) ? sensitivity : "unknown",
    sources: (row.sources as string[] | null) ?? [],
    sourceUnknown: row.source_unknown === true,
    ...(row.author ? { author: String(row.author) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const LIVE = `SELECT id, text, sensitivity, sources, source_unknown, author, created_at, updated_at
  FROM memory_facts WHERE scope_id = $1 AND deleted_at IS NULL ORDER BY id`;

export function createPostgresMemoryService(connectionString: string): MemoryService {
  const { q, pool } = createPgPool(connectionString, MEMORY_FACTS_MIGRATIONS);

  function tx(client: PoolClient, scopeId: ScopeId): FactStoreTx {
    return {
      list: async () => (await client.query(LIVE, [scopeId])).rows.map(fact),
      async insert(f) {
        await client.query(
          `INSERT INTO memory_facts(scope_id, text, sensitivity, sources, source_unknown, author, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [scopeId, f.text, f.sensitivity, f.sources, f.sourceUnknown, f.author ?? null, f.createdAt, f.updatedAt],
        );
      },
      async update(id, patch, at) {
        await client.query(
          `UPDATE memory_facts SET text = COALESCE($3, text), sensitivity = COALESCE($4, sensitivity),
             sources = COALESCE($5, sources), source_unknown = COALESCE($6, source_unknown), updated_at = $7
           WHERE scope_id = $1 AND id = $2`,
          [
            scopeId,
            id,
            patch.text ?? null,
            patch.sensitivity ?? null,
            patch.sources ?? null,
            patch.sourceUnknown ?? null,
            at,
          ],
        );
      },
      async remove(ids, at) {
        await client.query(
          "UPDATE memory_facts SET deleted_at = $3 WHERE scope_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL",
          [scopeId, ids, at],
        );
      },
    };
  }

  return createNotebookMemory({
    list: async (scopeId) => (await q(LIVE, [scopeId])).map(fact),
    transact: async (scopeId, fn) =>
      withPgTransaction(await pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scopeId]);
        return fn(tx(client, scopeId));
      }),
    async metadata() {
      const rows = await q(
        `SELECT scope_id, sum(octet_length(text)) AS bytes, max(updated_at) AS at
           FROM memory_facts WHERE deleted_at IS NULL GROUP BY scope_id`,
      );
      return new Map(
        rows.map((r) => [r.scope_id as ScopeId, { bytes: Number(r.bytes ?? 0), updatedAt: Number(r.at) }] as const),
      );
    },
  });
}
