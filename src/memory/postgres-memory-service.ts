import type { PoolClient } from "pg";
import type { ScopeId } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { createNotebookMemory, type FactStoreTx, type MemoryService } from "./memory-service.ts";
import { isMemorySensitivity, type MemoryFact } from "./facts.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memory_facts(
    id             BIGSERIAL PRIMARY KEY,
    scope_id       TEXT    NOT NULL,
    text           TEXT    NOT NULL,
    sensitivity    TEXT    NOT NULL,
    sources        TEXT[]  NOT NULL DEFAULT '{}',
    source_unknown BOOLEAN NOT NULL,
    author         TEXT,
    created_at     BIGINT  NOT NULL,
    updated_at     BIGINT  NOT NULL,
    deleted_at     BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS memory_facts_live ON memory_facts(scope_id, id) WHERE deleted_at IS NULL`,
  `DO $$
  BEGIN
    IF to_regclass('memory_revisions') IS NULL OR EXISTS (SELECT 1 FROM memory_facts) THEN RETURN; END IF;
    WITH head AS (
      SELECT DISTINCT ON (scope_id) scope_id, body, records, at
        FROM memory_revisions ORDER BY scope_id, seq DESC
    ),
    snapshot AS (
      SELECT h.scope_id, h.at, r.ord, r.rec->>'text' AS text,
             COALESCE(r.rec->>'sensitivity', 'unknown') AS sensitivity,
             ARRAY(SELECT DISTINCT s->>'scopeId' FROM jsonb_array_elements(COALESCE(r.rec->'sources', '[]')) s) AS sources,
             COALESCE((r.rec->>'sourceUnknown')::boolean, true) AS source_unknown
        FROM head h, jsonb_array_elements(h.records->'records') WITH ORDINALITY r(rec, ord)
       WHERE h.records IS NOT NULL
    ),
    lines AS (
      SELECT h.scope_id, h.at, l.ord, l.line,
             sum(CASE WHEN l.line ~ '^\\s*$' OR l.line ~ '^([-*] |#{1,6} )' OR l.line ~ '^\\s*<!-- ' THEN 1 ELSE 0 END)
               OVER (PARTITION BY h.scope_id ORDER BY l.ord) AS block
        FROM head h, regexp_split_to_table(h.body, E'\\n') WITH ORDINALITY l(line, ord)
       WHERE h.records IS NULL
    ),
    legacy AS (
      SELECT scope_id, at, min(ord) AS ord, btrim(string_agg(line, E'\\n' ORDER BY ord), E' \\n\\t\\r') AS text,
             'unknown' AS sensitivity, '{}'::text[] AS sources, true AS source_unknown
        FROM lines
       WHERE line !~ '^\\s*<!-- (consolidated: \\d{4}-\\d\\d-\\d\\d|captures-since-promote: \\d+) -->\\s*$'
       GROUP BY scope_id, at, block
    )
    INSERT INTO memory_facts(scope_id, text, sensitivity, sources, source_unknown, created_at, updated_at)
    SELECT scope_id, fact, sensitivity, sources, source_unknown,
           COALESCE(CASE WHEN to_char(day, 'YYYY-MM-DD') = d THEN (extract(epoch FROM day) * 1000)::bigint END, at), at
      FROM (SELECT g.*, regexp_replace(body, '^\\(\\d{4}-\\d\\d-\\d\\d\\)\\s*', '') AS fact,
                   timestamp '2000-01-01' + make_interval(years => substr(d, 1, 4)::int - 2000,
                     months => substr(d, 6, 2)::int - 1, days => substr(d, 9, 2)::int - 1) AS day
              FROM (SELECT f.*, substring(body FROM '^\\((\\d{4}-\\d\\d-\\d\\d)\\)') AS d
                      FROM (SELECT u.*, regexp_replace(btrim(regexp_replace(btrim(text), '^#{1,6} [^\\n]*\\n?', '')), '^[-*]\\s+', '') AS body
                              FROM (SELECT * FROM snapshot UNION ALL SELECT * FROM legacy) u
                             WHERE text !~ '^\\s*<!-- (consolidated|captures-since-promote)') f) g) x
     WHERE btrim(fact) <> ''
     ORDER BY scope_id, ord;
  END $$`,
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

export const MEMORY_FACTS_MIGRATIONS = [
  {
    id: "memory/facts/0000-records-column",
    statements: ["ALTER TABLE IF EXISTS memory_revisions ADD COLUMN IF NOT EXISTS records JSONB"],
  },
  { id: "memory/facts/0001", statements: SCHEMA },
  {
    id: "memory/facts/0002-text-hash",
    statements: [
      "ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS text_hash TEXT",
      `CREATE OR REPLACE FUNCTION memory_facts_text_hash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.text_hash := encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex');
        RETURN NEW;
      END $$`,
      "DROP TRIGGER IF EXISTS memory_facts_text_hash ON memory_facts",
      `CREATE TRIGGER memory_facts_text_hash BEFORE INSERT OR UPDATE OF text ON memory_facts
        FOR EACH ROW EXECUTE FUNCTION memory_facts_text_hash()`,
      "UPDATE memory_facts SET text_hash = encode(sha256(convert_to(text, 'UTF8')), 'hex') WHERE text_hash IS NULL",
      "ALTER TABLE memory_facts ALTER COLUMN text_hash SET NOT NULL",
    ],
  },
];

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
