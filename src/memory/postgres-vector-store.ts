import { createPgPool } from "../persistence/pg-pool.ts";
import { PGVECTOR_MAX_DIMENSIONS, unitVector } from "../model/embeddings.ts";
import { claimRows, type ClaimedRow } from "../tenants/claim.ts";

export interface MemoryVector {
  scope: string;
  model: string;
  factId: string;
  hash: string;
  vector: number[];
}

interface MemoryVectorMatch {
  factId: string;
  updatedAt: number;
  score: number;
}

interface MemoryVectorSearch {
  scope: string;
  model: string;
  vector: number[];
  ids: readonly string[];
  limit: number;
  minSimilarity?: number;
}

export interface MemoryVectorStore {
  search(input: MemoryVectorSearch): Promise<MemoryVectorMatch[]>;
  put(rows: readonly MemoryVector[], signal?: AbortSignal): Promise<void>;
  missing(
    model: string,
    limit: number,
    dimensions?: number,
    signal?: AbortSignal,
    afterId?: string,
  ): Promise<Array<{ scope: string; factId: string; hash: string; text: string }>>;
  prune(model: string, limit: number, dimensions?: number, signal?: AbortSignal): Promise<number>;
  claimTenants(): Promise<ClaimedRow[]>;
  close(): Promise<void>;
}

const SKETCH_CANDIDATES_PER_RESULT = 4;

const batchSize = (limit: number) => Math.max(1, Math.min(256, Math.floor(limit) || 1));

function vectorWidth(dimensions: number | undefined): number | null {
  if (dimensions === undefined) return null;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > PGVECTOR_MAX_DIMENSIONS)
    throw new Error("Invalid memory embedding dimensions");
  return dimensions;
}

export function createPostgresVectorStore(connectionString: string): MemoryVectorStore {
  const db = createPgPool(connectionString);
  return {
    async search(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1)
        throw new Error(`Memory vector search limit must be a positive integer, got ${input.limit}`);
      if (!input.ids.length) return [];
      const vector = unitVector(input.vector);
      const minSimilarity = input.minSimilarity ?? 0.2;
      const rows = await db.q(
        `WITH sketches AS MATERIALIZED (
          SELECT fact_id, fact_hash, embedding_bits <~> binary_quantize($4::vector) AS approx
          FROM memory_fact_vectors
          WHERE scope_id = $1 AND model = $2 AND dimensions = $3
        ),
        visible AS MATERIALIZED (
          SELECT f.id, f.updated_at, f.created_at, s.approx
          FROM memory_facts f
          LEFT JOIN sketches s ON s.fact_id = f.id AND s.fact_hash = f.text_hash
          WHERE f.scope_id = $1 AND f.deleted_at IS NULL AND f.id = ANY($7::bigint[])
        ),
        candidates AS (
          (SELECT id, updated_at, created_at, false AS unindexed FROM visible
            WHERE approx IS NOT NULL ORDER BY approx, id LIMIT $8::integer * $9::integer)
          UNION ALL
          (SELECT id, updated_at, created_at, true FROM visible
            WHERE approx IS NULL ORDER BY created_at DESC, id LIMIT $8)
        )
        SELECT id, updated_at, distance FROM (
          SELECT c.id, c.updated_at, c.created_at, c.unindexed,
            CASE WHEN c.unindexed THEN $6::double precision ELSE v.embedding <=> $4::vector END AS distance
          FROM candidates c
          LEFT JOIN memory_fact_vectors v ON NOT c.unindexed AND v.scope_id = $1 AND v.model = $2 AND v.fact_id = c.id
        ) ranked
        WHERE unindexed OR distance <= $5
        ORDER BY distance, created_at DESC, id
        LIMIT $8`,
        [
          input.scope,
          input.model,
          vector.length,
          JSON.stringify(vector),
          1 - minSimilarity,
          1 - Math.min(0.2, minSimilarity),
          input.ids,
          input.limit,
          SKETCH_CANDIDATES_PER_RESULT,
        ],
        { timeoutMs: 5000 },
      );
      return rows.map((row) => ({
        factId: String(row.id),
        updatedAt: Number(row.updated_at),
        score: 1 - Number(row.distance),
      }));
    },
    async put(rows, signal) {
      if (!rows.length) return;
      const latest = new Map(
        rows.map((row) => [
          JSON.stringify([row.scope, row.model, row.factId]),
          { ...row, vector: unitVector(row.vector) },
        ]),
      );
      await db.q(
        `WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(scope text, model text, "factId" bigint, hash text, vector jsonb)
        ),
        live AS MATERIALIZED (
          SELECT x.scope, x.model, x."factId", x.hash, x.vector
          FROM input x JOIN memory_facts f ON f.scope_id = x.scope AND f.id = x."factId"
            AND f.deleted_at IS NULL AND f.text_hash = x.hash
          ORDER BY f.id FOR SHARE OF f
        )
        INSERT INTO memory_fact_vectors(scope_id, model, fact_id, fact_hash, dimensions, embedding)
        SELECT scope, model, "factId", hash, jsonb_array_length(vector), vector::text::vector FROM live
        ON CONFLICT (tenant_id, scope_id, model, fact_id) DO UPDATE
        SET fact_hash = EXCLUDED.fact_hash, dimensions = EXCLUDED.dimensions, embedding = EXCLUDED.embedding`,
        [JSON.stringify([...latest.values()])],
        { signal, timeoutMs: 5000 },
      );
    },
    async missing(model, limit, dimensions, signal, afterId) {
      const rows = await db.q(
        `SELECT f.scope_id, f.id, f.text, f.text_hash AS hash
         FROM memory_facts f LEFT JOIN memory_fact_vectors v
           ON v.scope_id = f.scope_id AND v.fact_id = f.id AND v.model = $1
           AND v.fact_hash = f.text_hash
           AND ($3::integer IS NULL OR v.dimensions = $3)
         WHERE f.deleted_at IS NULL AND v.fact_id IS NULL AND ($4::bigint IS NULL OR f.id > $4)
         ORDER BY f.id LIMIT $2`,
        [model, batchSize(limit), vectorWidth(dimensions), afterId ?? null],
        { signal, timeoutMs: 5000 },
      );
      return rows.map((row) => ({
        scope: String(row.scope_id),
        factId: String(row.id),
        hash: String(row.hash),
        text: String(row.text),
      }));
    },
    async prune(model, limit, dimensions, signal) {
      const { rowCount } = await db.query(
        `DELETE FROM memory_fact_vectors v USING (
          SELECT s.scope_id, s.model, s.fact_id FROM memory_fact_vectors s
          WHERE s.model <> $1 OR ($3::integer IS NOT NULL AND s.dimensions <> $3) OR NOT EXISTS (
            SELECT 1 FROM memory_facts f
            WHERE f.scope_id = s.scope_id AND f.id = s.fact_id
              AND f.deleted_at IS NULL AND f.text_hash = s.fact_hash
          )
          LIMIT $2 FOR UPDATE OF s SKIP LOCKED
        ) stale
        WHERE v.scope_id = stale.scope_id AND v.model = stale.model AND v.fact_id = stale.fact_id`,
        [model, batchSize(limit), vectorWidth(dimensions)],
        { signal, timeoutMs: 30_000 },
      );
      return rowCount;
    },
    claimTenants: () => claimRows(db, "claim_memory_tenants"),
    close: () => db.close(),
  };
}
