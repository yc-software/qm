import type { CronFireLogEntry } from "../types.ts";
import { createPgPool, withPgTransaction, tenantCols } from "../persistence/pg-pool.ts";
import { pgTextSafe } from "../util/text.ts";

export interface CronFireRecord extends CronFireLogEntry {
  cronId: string;
}

export type BeginFireResult = { begun: true } | { begun: false; running?: CronFireLogEntry };

export interface CronFireStore {
  record(cronId: string, entry: CronFireLogEntry): Promise<void>;

  beginExclusive(cronId: string, entry: CronFireLogEntry, staleRunningMs: number): Promise<BeginFireResult>;

  sweepStranded(now: number, staleRunningMs: number, note: string): Promise<number>;

  pruneEnded(opts: { endedBefore: number; keepPerCron: number }): Promise<number>;
  listByCron(cronId: string, opts?: { limit?: number }): Promise<{ runs: CronFireLogEntry[]; total: number }>;
  listByThreadRefs(threadRefs: readonly string[]): Promise<CronFireRecord[]>;
  latestForThread(cronId: string, threadRef: string): Promise<CronFireLogEntry | undefined>;
}

interface FireColumn {
  name: string;
  value(cronId: string, entry: CronFireLogEntry): string | number | null;
}

const FIRE_COLUMN_DEFS: readonly FireColumn[] = [
  { name: "cron_id", value: (cronId) => cronId },
  { name: "fire_key", value: (_cronId, e) => e.fireKey },
  { name: "thread_ref", value: (_cronId, e) => e.threadRef },
  { name: "session_id", value: (_cronId, e) => e.sessionId ?? null },
  { name: "fired_at", value: (_cronId, e) => e.firedAt },
  { name: "scheduled_at", value: (_cronId, e) => e.scheduledAt ?? null },
  { name: "ended_at", value: (_cronId, e) => e.endedAt ?? null },
  { name: "status", value: (_cronId, e) => e.status ?? null },
  { name: "note", value: (_cronId, e) => (e.note !== undefined ? pgTextSafe(e.note) : null) },
  { name: "reply", value: (_cronId, e) => (e.reply !== undefined ? pgTextSafe(e.reply) : null) },
];

const FIRE_COLUMNS = FIRE_COLUMN_DEFS.map((c) => c.name).join(", ");
const VALUE_COLUMN_DEFS = FIRE_COLUMN_DEFS.filter((c) => c.name !== "cron_id" && c.name !== "fire_key");
const UPSERT_SET = VALUE_COLUMN_DEFS.map((c) => `${c.name} = EXCLUDED.${c.name}`).join(", ");

// Built per call: tenantCols depends on whether tenancy is on, which is decided after this module loads.
const upsertFire = (): string => `INSERT INTO cron_fires (${FIRE_COLUMNS})
   VALUES (${FIRE_COLUMN_DEFS.map((_c, i) => `$${i + 1}`).join(", ")})
   ON CONFLICT (${tenantCols("cron_id, fire_key")}) DO UPDATE
     SET ${UPSERT_SET}`;

function fireParams(cronId: string, entry: CronFireLogEntry): unknown[] {
  return FIRE_COLUMN_DEFS.map((c) => c.value(cronId, entry));
}

function rowToEntry(r: Record<string, unknown>): CronFireLogEntry {
  return {
    fireKey: r.fire_key as string,
    threadRef: r.thread_ref as string,
    firedAt: Number(r.fired_at),
    ...(r.session_id != null ? { sessionId: r.session_id as string } : {}),
    ...(r.scheduled_at != null ? { scheduledAt: Number(r.scheduled_at) } : {}),
    ...(r.ended_at != null ? { endedAt: Number(r.ended_at) } : {}),
    ...(r.status != null ? { status: r.status as CronFireLogEntry["status"] } : {}),
    ...(r.note != null ? { note: r.note as string } : {}),
    ...(r.reply != null ? { reply: r.reply as string } : {}),
  };
}

const LEGACY_LOG_FIELDS = [
  "source.cron_id",
  "source.fire_key",
  "COALESCE(source.json->>'threadRef', 'cron:' || source.cron_id)",
  "source.json->>'sessionId'",
  "source.fired_at",
  "(source.json->>'scheduledAt')::bigint",
  "COALESCE((source.json->>'endedAt')::bigint, CASE WHEN source.json->>'status' IS DISTINCT FROM 'running' THEN source.fired_at END)",
  "source.json->>'status'",
  "source.json->>'note'",
  "source.json->>'reply'",
].join(", ");

const JSON_LOG_FIELDS = [
  "c.id",
  "e->>'fireKey'",
  "COALESCE(e->>'threadRef', 'cron:' || c.id)",
  "e->>'sessionId'",
  "(e->>'firedAt')::bigint",
  "(e->>'scheduledAt')::bigint",
  "COALESCE((e->>'endedAt')::bigint, CASE WHEN e->>'status' IS DISTINCT FROM 'running' THEN (e->>'firedAt')::bigint END)",
  "e->>'status'",
  "e->>'note'",
  "e->>'reply'",
].join(", ");

const hasTenantColumn = (table: string) =>
  `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = 'tenant_id' AND NOT attisdropped)`;

/**
 * Fire history used to live in two older places: a `fireLog` array on each cron's JSON and a
 * `cron_fire_log` table kept in step by a trigger. Import whatever is left of both into cron_fires,
 * then remove the old copies so cron_fires is the only history.
 */
const RETIRE_LEGACY_FIRE_HISTORY = {
  id: "cron/fires/0002-retire-legacy-history",
  statements: [
    `DO $body$ BEGIN
      IF to_regclass('cron_fire_log') IS NOT NULL THEN
        INSERT INTO cron_fires (${FIRE_COLUMNS})
        SELECT ${LEGACY_LOG_FIELDS} FROM cron_fire_log source
        ON CONFLICT DO NOTHING;
        DROP TABLE cron_fire_log;
      END IF;
      DROP FUNCTION IF EXISTS qm_sync_legacy_cron_fire();
      IF to_regclass('crons') IS NOT NULL THEN
        IF ${hasTenantColumn("crons")} AND ${hasTenantColumn("cron_fires")} THEN
          INSERT INTO cron_fires (tenant_id, ${FIRE_COLUMNS})
          SELECT c.tenant_id, ${JSON_LOG_FIELDS} FROM crons c, jsonb_array_elements(c.json->'fireLog') e
           WHERE jsonb_typeof(c.json->'fireLog') = 'array' AND e ? 'fireKey' AND e ? 'firedAt'
          ON CONFLICT DO NOTHING;
        ELSE
          INSERT INTO cron_fires (${FIRE_COLUMNS})
          SELECT ${JSON_LOG_FIELDS} FROM crons c, jsonb_array_elements(c.json->'fireLog') e
           WHERE jsonb_typeof(c.json->'fireLog') = 'array' AND e ? 'fireKey' AND e ? 'firedAt'
          ON CONFLICT DO NOTHING;
        END IF;
        UPDATE crons SET json = json - 'fireLog' WHERE json ? 'fireLog';
      END IF;
    END $body$`,
  ],
};

const DROP_OLD_FIRE_SYNC = {
  id: "cron/fires/0003-drop-old-fire-sync",
  statements: ["DROP FUNCTION IF EXISTS qm_sync_legacy_cron_fire()"],
};

export function createPostgresCronFireStore(connectionString: string): CronFireStore {
  const { q, query, pool } = createPgPool(connectionString, [RETIRE_LEGACY_FIRE_HISTORY, DROP_OLD_FIRE_SYNC]);

  return {
    async record(cronId, entry) {
      await query(upsertFire(), fireParams(cronId, entry));
    },
    async beginExclusive(cronId, entry, staleRunningMs) {
      return withPgTransaction(await pool(), async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`cron_fires:${cronId}`]);
        const running = await client.query(
          `SELECT ${FIRE_COLUMNS} FROM cron_fires
            WHERE cron_id = $1 AND fire_key <> $2 AND status = 'running' AND fired_at > $3
            ORDER BY fired_at DESC, fire_key DESC
            LIMIT 1`,
          [cronId, entry.fireKey, entry.firedAt - staleRunningMs],
        );
        const row = running.rows[0] as Record<string, unknown> | undefined;
        if (row) return { begun: false, running: rowToEntry(row) };
        await client.query(upsertFire(), fireParams(cronId, entry));
        return { begun: true };
      });
    },
    async sweepStranded(now, staleRunningMs, note) {
      const result = await query(
        `UPDATE cron_fires
            SET status = 'failed', ended_at = $1, note = $2
          WHERE status = 'running' AND fired_at <= $3`,
        [now, pgTextSafe(note), now - staleRunningMs],
      );
      return result.rowCount;
    },
    async pruneEnded({ endedBefore, keepPerCron }) {
      const result = await query(
        `DELETE FROM cron_fires cf
          USING (SELECT cron_id, fire_key,
                        ROW_NUMBER() OVER (PARTITION BY cron_id ORDER BY fired_at DESC, fire_key DESC) AS rn
                   FROM cron_fires) ranked
          WHERE cf.cron_id = ranked.cron_id AND cf.fire_key = ranked.fire_key
            AND ranked.rn > $1
            AND cf.ended_at IS NOT NULL AND cf.ended_at < $2`,
        [keepPerCron, endedBefore],
      );
      return result.rowCount ?? 0;
    },
    async listByCron(cronId, opts) {
      if (opts?.limit !== undefined && opts.limit <= 0) {
        const counted = await q(`SELECT COUNT(*)::int AS total FROM cron_fires WHERE cron_id = $1`, [cronId]);
        return { runs: [], total: Number(counted[0]?.total ?? 0) };
      }
      if (opts?.limit !== undefined) {
        const rows = await q(
          `SELECT ${FIRE_COLUMNS}, COUNT(*) OVER ()::int AS total FROM cron_fires
            WHERE cron_id = $1
            ORDER BY fired_at DESC, fire_key DESC
            LIMIT $2`,
          [cronId, opts.limit],
        );
        const total = rows.length ? Number(rows[0]!.total) : 0;
        return { runs: rows.reverse().map(rowToEntry), total };
      }
      const rows = await q(
        `SELECT ${FIRE_COLUMNS} FROM cron_fires
          WHERE cron_id = $1
          ORDER BY fired_at, fire_key`,
        [cronId],
      );
      return { runs: rows.map(rowToEntry), total: rows.length };
    },
    async listByThreadRefs(threadRefs) {
      if (!threadRefs.length) return [];
      const rows = await q(
        `SELECT ${FIRE_COLUMNS} FROM cron_fires
          WHERE thread_ref = ANY($1)
          ORDER BY fired_at, fire_key`,
        [[...threadRefs]],
      );
      return rows.map((r) => ({ ...rowToEntry(r), cronId: r.cron_id as string }));
    },
    async latestForThread(cronId, threadRef) {
      const rows = await q(
        `SELECT ${FIRE_COLUMNS} FROM cron_fires
          WHERE cron_id = $1 AND thread_ref = $2
          ORDER BY fired_at DESC, fire_key DESC
          LIMIT 1`,
        [cronId, threadRef],
      );
      return rows[0] ? rowToEntry(rows[0]) : undefined;
    },
  };
}
