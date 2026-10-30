import { createMemoryMap } from "../persistence/durable-map.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { keyValueConversion } from "../persistence/kv-conversion.ts";
import { TENANT } from "../tenants/migrations.ts";

export interface AmbientCursor {
  lastJudgedTs: string;
  lastJudgedAt?: number;
}

export interface AmbientCursorStore {
  get(surface: string, container: string): Promise<AmbientCursor | null>;
  put(surface: string, container: string, cursor: AmbientCursor): Promise<void>;
  close?(): Promise<void>;
}

const surfaceOf = (row: string) => `split_part(${row}.id, ':', 2)`;
const containerOf = (row: string) => `regexp_replace(${row}.id, '^[^:]*:[^:]*:', '')`;
const OLD = "ambient_cursors_kv";

export const AMBIENT_CURSORS_MIGRATION = keyValueConversion({
  table: "ambient_cursors",
  columns: [
    "surface TEXT NOT NULL",
    "container TEXT NOT NULL",
    "last_judged_ts TEXT NOT NULL",
    "last_judged_at BIGINT",
  ],
  primaryKey: ["surface", "container"],
  backfill: {
    surface: surfaceOf(OLD),
    container: containerOf(OLD),
    last_judged_ts: "json->>'lastJudgedTs'",
    last_judged_at: "(json->>'lastJudgedAt')::numeric::bigint",
  },
  where: `json->>'lastJudgedTs' IS NOT NULL AND id ~ '^[^:]*:[^:]+:.+$'
    AND NOT EXISTS (
      SELECT 1 FROM ${OLD} newer
       WHERE ${surfaceOf("newer")} = ${surfaceOf(OLD)} AND ${containerOf("newer")} = ${containerOf(OLD)}
         AND newer.json->>'lastJudgedTs' IS NOT NULL
         AND (newer.json->>'lastJudgedTs', newer.id) > (${OLD}.json->>'lastJudgedTs', ${OLD}.id))`,
});

export function createAmbientCursorStore(): AmbientCursorStore {
  const map = createMemoryMap<AmbientCursor>();
  const key = (surface: string, container: string) => JSON.stringify([surface, container]);
  return {
    get: (surface, container) => map.get(key(surface, container)),
    put: (surface, container, cursor) => map.put(key(surface, container), cursor),
  };
}

export function createPostgresAmbientCursorStore(connectionString: string): AmbientCursorStore {
  const { q, close } = createPgPool(connectionString, [AMBIENT_CURSORS_MIGRATION]);
  return {
    async get(surface, container) {
      const rows = await q(
        `SELECT last_judged_ts, last_judged_at FROM ambient_cursors
          WHERE tenant_id = ${TENANT} AND surface = $1 AND container = $2`,
        [surface, container],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        lastJudgedTs: String(row.last_judged_ts),
        ...(row.last_judged_at == null ? {} : { lastJudgedAt: Number(row.last_judged_at) }),
      };
    },
    async put(surface, container, cursor) {
      await q(
        `INSERT INTO ambient_cursors(surface, container, last_judged_ts, last_judged_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, surface, container) DO UPDATE SET
           last_judged_ts = EXCLUDED.last_judged_ts, last_judged_at = EXCLUDED.last_judged_at`,
        [surface, container, cursor.lastJudgedTs, cursor.lastJudgedAt ?? null],
      );
    },
    close,
  };
}
