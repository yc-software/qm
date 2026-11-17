import type { PoolClient } from "pg";
import type { ScopeId } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { createNotebookMemory, type FactStoreTx, type MemoryService } from "./memory-service.ts";
import { isMemorySensitivity, type MemoryFact } from "./facts.ts";

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
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const LIVE = `SELECT id, text, sensitivity, sources, source_unknown, author, session_id, created_at, updated_at
  FROM memory_facts WHERE scope_id = $1 AND deleted_at IS NULL ORDER BY id`;

export function createPostgresMemoryService(connectionString: string): MemoryService {
  const { q, pool } = createPgPool(connectionString);

  function tx(client: PoolClient, scopeId: ScopeId): FactStoreTx {
    return {
      list: async () => (await client.query(LIVE, [scopeId])).rows.map(fact),
      async insert(f) {
        await client.query(
          `INSERT INTO memory_facts(scope_id, text, sensitivity, sources, source_unknown, author, session_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            scopeId,
            f.text,
            f.sensitivity,
            f.sources,
            f.sourceUnknown,
            f.author ?? null,
            f.sessionId ?? null,
            f.createdAt,
            f.updatedAt,
          ],
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
