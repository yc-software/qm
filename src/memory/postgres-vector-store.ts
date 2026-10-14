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
  hash: string;
  score: number;
}

export interface MemoryVectorSearch {
  scope: string;
  model: string;
  vector: number[];
  facts: readonly { id: string; hash: string; at: number }[];
  minSimilarity?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface MemoryVectorStore {
  search(input: MemoryVectorSearch): AsyncIterable<MemoryVectorMatch[]>;
  put(rows: readonly MemoryVector[], signal?: AbortSignal): Promise<void>;
  remove(scope: string, factIds: readonly string[], signal?: AbortSignal): Promise<void>;
  missing(
    model: string,
    limit: number,
    dimensions?: number,
    signal?: AbortSignal,
    afterId?: string,
  ): Promise<Array<{ scope: string; factId: string; hash: string; text: string }>>;
  prune(model: string, limit: number, dimensions?: number, signal?: AbortSignal): Promise<number>;
  migrateLegacy(
    model: string,
    dimensions: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ processed: number; done: boolean }>;
  close(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memory_fact_vectors (
    scope_id TEXT NOT NULL,
    model TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    fact_hash TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
    embedding vector NOT NULL,
    PRIMARY KEY (scope_id, model, fact_id),
    CHECK (vector_dims(embedding) = dimensions)
  )`,
];

const LEGACY_PROGRESS = [
  `CREATE TABLE IF NOT EXISTS memory_vector_legacy_progress (
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    cursor TEXT,
    done BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (model, dimensions)
  )`,
];

const FACT_HASH = "encode(sha256(convert_to(f.text, 'UTF8')), 'hex')";
const MAX_FACT_ID = 9223372036854775807n;
const factIdKey = (column: string) =>
  `CASE WHEN ${column} ~ '^[0-9]{1,19}$' AND ${column}::numeric <= ${MAX_FACT_ID} THEN ${column}::bigint END`;
const batchSize = (limit: number) => Math.max(1, Math.min(256, Math.floor(limit) || 1));

function vectorWidth(dimensions: number | undefined): number | null {
  if (dimensions === undefined) return null;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000)
    throw new Error("Invalid memory embedding dimensions");
  return dimensions;
}

function legacyVector(row: Record<string, unknown>, dimensions: number) {
  if (typeof row.scope !== "string" || typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash)) return;
  try {
    const vector = unitVector(row.vector);
    return vector.length === dimensions ? { scope: row.scope, hash: row.hash, vector } : undefined;
  } catch {
    return;
  }
}

export function createPostgresVectorStore(connectionString: string): MemoryVectorStore {
  const db = createPgPool(connectionString, [
    { id: "memory/vectors/0001-extension", statements: ["CREATE EXTENSION IF NOT EXISTS vector"] },
    { id: "memory/vectors/0002", statements: SCHEMA },
    { id: "memory/vectors/0003-legacy-progress", statements: LEGACY_PROGRESS },
  ]);
  return {
    async *search(input) {
      if (!input.facts.length) return;
      const vector = unitVector(input.vector);
      const pageSize = Math.max(1, Math.min(256, Math.floor(input.pageSize ?? 64)));
      const params = [
        input.scope,
        input.model,
        vector.length,
        input.facts.map((fact) => fact.id),
        input.facts.map((fact) => fact.hash),
        input.facts.map((fact) => fact.at),
      ];
      const options = { signal: input.signal, timeoutMs: 5000 };
      const eligible = `WITH scoped AS MATERIALIZED (
          SELECT wanted.id AS fact_id, wanted.hash AS wanted_hash, wanted.at, ${FACT_HASH} AS live_hash,
            v.fact_hash, v.embedding
          FROM unnest($4::text[], $5::text[], $6::bigint[]) AS wanted(id, hash, at)
          JOIN memory_facts f ON f.scope_id = $1 AND f.id = ${factIdKey("wanted.id")} AND f.deleted_at IS NULL
          LEFT JOIN memory_fact_vectors v ON v.scope_id = $1 AND v.model = $2 AND v.dimensions = $3
            AND v.fact_id = wanted.id
        )
        SELECT fact_id, wanted_hash AS fact_hash, at,
          CASE WHEN fact_hash = wanted_hash THEN embedding END AS embedding
        FROM scoped WHERE wanted_hash = live_hash`;
      const minSimilarity = input.minSimilarity ?? 0.2;
      let cursor: { distance: number; at: number; id: string } | undefined;
      for (;;) {
        input.signal?.throwIfAborted();
        const rows = await db.q(
          `WITH eligible AS MATERIALIZED (${eligible}),
          ranked AS MATERIALIZED (
            SELECT fact_id, fact_hash, at, embedding IS NULL AS unindexed,
              CASE WHEN embedding IS NULL THEN $13::double precision ELSE embedding <=> $7::vector END AS distance
            FROM eligible
          )
          SELECT fact_id, fact_hash, at, distance FROM ranked
          WHERE (unindexed OR distance <= $8) AND ($9::double precision IS NULL
            OR distance > $9 OR (distance = $9 AND at < $10)
            OR (distance = $9 AND at = $10 AND fact_id COLLATE "C" > $11))
          ORDER BY distance, at DESC, fact_id COLLATE "C" LIMIT $12`,
          [
            ...params,
            JSON.stringify(vector),
            1 - minSimilarity,
            cursor?.distance ?? null,
            cursor?.at ?? null,
            cursor?.id ?? null,
            pageSize,
            1 - Math.min(0.2, minSimilarity),
          ],
          options,
        );
        if (!rows.length) return;
        const last = rows[rows.length - 1]!;
        cursor = { distance: Number(last.distance), at: Number(last.at), id: String(last.fact_id) };
        yield rows.map((row) => ({
          factId: String(row.fact_id),
          hash: String(row.fact_hash),
          score: 1 - Number(row.distance),
        }));
        if (rows.length < pageSize) return;
      }
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
          SELECT scope, model, "factId", hash, vector, ${factIdKey('"factId"')} AS fact_key
          FROM jsonb_to_recordset($1::jsonb) AS x(scope text, model text, "factId" text, hash text, vector jsonb)
        ),
        live AS MATERIALIZED (
          SELECT x.scope, x.model, x."factId", x.hash, x.vector
          FROM input x JOIN memory_facts f ON f.scope_id = x.scope AND f.id = x.fact_key
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
    async remove(scope, factIds, signal) {
      if (!factIds.length) return;
      await db.q(
        "DELETE FROM memory_fact_vectors WHERE scope_id = $1 AND fact_id = ANY($2::text[])",
        [scope, factIds],
        { signal, timeoutMs: 5000 },
      );
    },
    async missing(model, limit, dimensions, signal, afterId) {
      if (afterId !== undefined && !(/^[0-9]{1,19}$/.test(afterId) && BigInt(afterId) <= MAX_FACT_ID))
        throw new Error("Invalid memory fact cursor");
      const rows = await db.q(
        `SELECT f.scope_id, f.id, f.text, ${FACT_HASH} AS hash
         FROM memory_facts f LEFT JOIN memory_fact_vectors v
           ON v.scope_id = f.scope_id AND v.fact_id = f.id::text AND v.model = $1
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
            WHERE f.scope_id = s.scope_id AND f.id = ${factIdKey("s.fact_id")}
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
    async migrateLegacy(model, dimensions, limit, signal) {
      const width = vectorWidth(dimensions)!;
      const size = batchSize(limit);
      const options = { signal, timeoutMs: 30_000 };
      const [state] = await db.q(
        `WITH created AS (
          INSERT INTO memory_vector_legacy_progress(model, dimensions) VALUES ($1, $2)
          ON CONFLICT (model, dimensions) DO NOTHING RETURNING cursor, done
        )
        SELECT cursor, done, to_regclass('memory_vectors') IS NOT NULL AS source FROM created
        UNION ALL
        SELECT cursor, done, to_regclass('memory_vectors') IS NOT NULL FROM memory_vector_legacy_progress
        WHERE model = $1 AND dimensions = $2`,
        [model, width],
        options,
      );
      if (!state || state.done || !state.source) return { processed: 0, done: true };
      const rows = await db.q(
        `SELECT id, json->>'scope' AS scope, json->>'hash' AS hash,
          CASE WHEN json->>'model' = $3 AND jsonb_typeof(json->'vector') = 'array' THEN
            CASE WHEN jsonb_array_length(json->'vector') = $4 THEN json->'vector' END END AS vector
        FROM memory_vectors WHERE $1::text IS NULL OR id > $1 ORDER BY id LIMIT $2`,
        [state.cursor ?? null, size, model, width],
        options,
      );
      const valid = rows.flatMap((row) => legacyVector(row, width) ?? []);
      if (valid.length) {
        await db.q(
          `INSERT INTO memory_fact_vectors(scope_id, model, fact_id, fact_hash, dimensions, embedding)
          SELECT x.scope, $2, f.id::text, x.hash, $3, x.vector::text::vector
          FROM jsonb_to_recordset($1::jsonb) AS x(scope text, hash text, vector jsonb)
          JOIN memory_facts f ON f.scope_id = x.scope AND f.deleted_at IS NULL AND ${FACT_HASH} = x.hash
          ON CONFLICT (scope_id, model, fact_id) DO NOTHING`,
          [JSON.stringify(valid), model, width],
          options,
        );
      }
      const done = rows.length < size;
      await db.q(
        `UPDATE memory_vector_legacy_progress SET cursor = COALESCE($3, cursor), done = done OR $4
        WHERE model = $1 AND dimensions = $2 AND ($3::text IS NULL OR cursor IS NULL OR cursor < $3)`,
        [model, width, rows.at(-1)?.id ?? null, done],
        options,
      );
      return { processed: rows.length, done };
    },
    close: () => db.close(),
  };
}
