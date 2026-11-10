import { createPgPool, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { PGVECTOR_MAX_DIMENSIONS, unitVector } from "../model/embeddings.ts";
import { MEMORY_FACTS_MIGRATIONS } from "./postgres-memory-service.ts";
import { tenantTables } from "../tenants/migrations.ts";
import { claimFunction, claimRows, type ClaimedRow } from "../tenants/claim.ts";

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

const SKETCH_CANDIDATES_PER_RESULT = 4;

const batchSize = (limit: number) => Math.max(1, Math.min(256, Math.floor(limit) || 1));

function vectorWidth(dimensions: number | undefined): number | null {
  if (dimensions === undefined) return null;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > PGVECTOR_MAX_DIMENSIONS)
    throw new Error("Invalid memory embedding dimensions");
  return dimensions;
}

export const VECTOR_MIGRATIONS: PgMigrationDefinition[] = [
  ...MEMORY_FACTS_MIGRATIONS,
  {
    id: "memory/vectors/0001-vector-extension",
    statements: [
      `DO $ext$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
          CREATE EXTENSION vector;
        END IF;
      END $ext$`,
    ],
  },
  { id: "memory/vectors/0002", statements: SCHEMA },
  {
    id: "memory/vectors/0003-sketch",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "ALTER TABLE memory_fact_vectors ADD COLUMN IF NOT EXISTS embedding_bits BIT VARYING",
      `CREATE OR REPLACE FUNCTION memory_fact_vectors_bits() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.embedding_bits := binary_quantize(NEW.embedding);
          RETURN NEW;
        END $$`,
      "DROP TRIGGER IF EXISTS memory_fact_vectors_bits ON memory_fact_vectors",
      `CREATE TRIGGER memory_fact_vectors_bits BEFORE INSERT OR UPDATE OF embedding ON memory_fact_vectors
          FOR EACH ROW EXECUTE FUNCTION memory_fact_vectors_bits()`,
    ],
  },
  {
    id: "memory/vectors/0004-sketch-backfill",
    autocommit: true,
    statements: [
      `DO $memory_sketch_backfill$
        DECLARE
          batch tid[];
        BEGIN
          LOOP
            SELECT array_agg(ctid) INTO batch
              FROM (SELECT ctid FROM memory_fact_vectors WHERE embedding_bits IS NULL LIMIT 1000) pending;
            EXIT WHEN batch IS NULL;
            UPDATE memory_fact_vectors SET embedding_bits = binary_quantize(embedding)
             WHERE ctid = ANY(batch) AND embedding_bits IS NULL;
            COMMIT;
          END LOOP;
        END $memory_sketch_backfill$`,
    ],
  },
  ...tenantTables("memory/vectors/0003-tenants", [
    { table: "memory_fact_vectors", primaryKey: "scope_id, model, fact_id" },
  ]),
  {
    id: "memory/vectors/0004-claims",
    statements: [
      claimFunction(
        "claim_memory_index",
        "model text, dims integer",
        `SELECT f.tenant_id, 'memory'::text FROM memory_facts f
             WHERE f.deleted_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM memory_fact_vectors v
                WHERE v.tenant_id = f.tenant_id AND v.scope_id = f.scope_id AND v.fact_id = f.id AND v.model = $1
                  AND v.fact_hash = f.text_hash AND ($2::integer IS NULL OR v.dimensions = $2))
             GROUP BY f.tenant_id
           UNION
           SELECT s.tenant_id, 'memory'::text FROM memory_fact_vectors s
             WHERE s.model <> $1 OR ($2::integer IS NOT NULL AND s.dimensions <> $2) OR NOT EXISTS (
               SELECT 1 FROM memory_facts f
                WHERE f.tenant_id = s.tenant_id AND f.scope_id = s.scope_id AND f.id = s.fact_id
                  AND f.deleted_at IS NULL AND f.text_hash = s.fact_hash)
             GROUP BY s.tenant_id`,
      ),
    ],
  },
  {
    id: "memory/vectors/0005-claim-tenants",
    statements: [
      "DROP FUNCTION IF EXISTS claim_memory_index(text, integer)",
      claimFunction(
        "claim_memory_tenants",
        "",
        `SELECT tenant_id, 'memory'::text FROM memory_facts WHERE deleted_at IS NULL
           UNION SELECT tenant_id, 'memory'::text FROM memory_fact_vectors`,
      ),
    ],
  },
];

export function createPostgresVectorStore(connectionString: string): MemoryVectorStore {
  const db = createPgPool(connectionString, VECTOR_MIGRATIONS);
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

export async function registerVectorMigrations(connectionString: string): Promise<void> {
  const pg = createPgPool(connectionString);
  try {
    const available = await pg.q("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    if (available.length) for (const migration of VECTOR_MIGRATIONS) pg.registerMigration(migration);
  } finally {
    await pg.close();
  }
}
