import { createPgPool } from "../persistence/pg-pool.ts";
import { unitVector } from "../model/embeddings.ts";

export interface MemoryVector {
  scope: string;
  model: string;
  factId: string;
  hash: string;
  vector: number[];
}

export interface MemoryVectorMatch {
  factId: string;
  score: number;
}

export interface MemoryVectorSearch {
  scope: string;
  model: string;
  vector: number[];
  facts: readonly { id: string; hash: string; at: number }[];
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
  close(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memory_fact_vectors (
    scope_id TEXT NOT NULL,
    model TEXT NOT NULL,
    fact_id BIGINT NOT NULL,
    fact_hash TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
    embedding vector NOT NULL,
    PRIMARY KEY (scope_id, model, fact_id),
    CHECK (vector_dims(embedding) = dimensions)
  )`,
];

const FACT_HASH = "encode(sha256(convert_to(f.text, 'UTF8')), 'hex')";
const batchSize = (limit: number) => Math.max(1, Math.min(256, Math.floor(limit) || 1));

function vectorWidth(dimensions: number | undefined): number | null {
  if (dimensions === undefined) return null;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000)
    throw new Error("Invalid memory embedding dimensions");
  return dimensions;
}

export function createPostgresVectorStore(connectionString: string): MemoryVectorStore {
  const db = createPgPool(connectionString, [
    { id: "memory/vectors/0001-extension", statements: ["CREATE EXTENSION IF NOT EXISTS vector"] },
    { id: "memory/vectors/0002", statements: SCHEMA },
  ]);
  return {
    async search(input) {
      if (!input.facts.length) return [];
      const vector = unitVector(input.vector);
      const minSimilarity = input.minSimilarity ?? 0.2;
      const rows = await db.q(
        `WITH scoped AS MATERIALIZED (
          SELECT wanted.id, wanted.hash, wanted.at, ${FACT_HASH} AS live_hash, v.fact_hash, v.embedding
          FROM unnest($4::bigint[], $5::text[], $6::bigint[]) AS wanted(id, hash, at)
          JOIN memory_facts f ON f.scope_id = $1 AND f.id = wanted.id AND f.deleted_at IS NULL
          LEFT JOIN memory_fact_vectors v ON v.scope_id = $1 AND v.model = $2 AND v.dimensions = $3
            AND v.fact_id = wanted.id
        ),
        ranked AS MATERIALIZED (
          SELECT id, hash, at, fact_hash IS DISTINCT FROM hash AS unindexed,
            CASE WHEN fact_hash = hash THEN embedding <=> $7::vector ELSE $9::double precision END AS distance
          FROM scoped WHERE hash = live_hash
        )
        SELECT id, distance FROM ranked WHERE unindexed OR distance <= $8 ORDER BY distance, at DESC, id`,
        [
          input.scope,
          input.model,
          vector.length,
          input.facts.map((fact) => fact.id),
          input.facts.map((fact) => fact.hash),
          input.facts.map((fact) => fact.at),
          JSON.stringify(vector),
          1 - minSimilarity,
          1 - Math.min(0.2, minSimilarity),
        ],
        { timeoutMs: 5000 },
      );
      return rows.map((row) => ({
        factId: String(row.id),
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
            AND f.deleted_at IS NULL AND ${FACT_HASH} = x.hash
          ORDER BY f.id FOR SHARE OF f
        )
        INSERT INTO memory_fact_vectors(scope_id, model, fact_id, fact_hash, dimensions, embedding)
        SELECT scope, model, "factId", hash, jsonb_array_length(vector), vector::text::vector FROM live
        ON CONFLICT (scope_id, model, fact_id) DO UPDATE
        SET fact_hash = EXCLUDED.fact_hash, dimensions = EXCLUDED.dimensions, embedding = EXCLUDED.embedding`,
        [JSON.stringify([...latest.values()])],
        { signal, timeoutMs: 5000 },
      );
    },
    async missing(model, limit, dimensions, signal, afterId) {
      const rows = await db.q(
        `SELECT f.scope_id, f.id, f.text, ${FACT_HASH} AS hash
         FROM memory_facts f LEFT JOIN memory_fact_vectors v
           ON v.scope_id = f.scope_id AND v.fact_id = f.id AND v.model = $1
           AND v.fact_hash = ${FACT_HASH}
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
              AND f.deleted_at IS NULL AND ${FACT_HASH} = s.fact_hash
          )
          LIMIT $2 FOR UPDATE OF s SKIP LOCKED
        ) stale
        WHERE v.scope_id = stale.scope_id AND v.model = stale.model AND v.fact_id = stale.fact_id`,
        [model, batchSize(limit), vectorWidth(dimensions)],
        { signal, timeoutMs: 30_000 },
      );
      return rowCount;
    },
    close: () => db.close(),
  };
}
