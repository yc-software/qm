import type { CronFireLogEntry } from "../triggers/types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { pgTextSafe } from "../util/text.ts";
import { tenantTables } from "../tenants/migrations.ts";
import { claimFunction, claimRows } from "../tenants/claim.ts";

export interface CronFireRecord extends CronFireLogEntry {
  cronId: string;
}

export type BeginFireResult = { begun: true } | { begun: false; running?: CronFireLogEntry };

export interface CronFireStore {
  record(cronId: string, entry: CronFireLogEntry): Promise<void>;

  beginExclusive(cronId: string, entry: CronFireLogEntry, staleRunningMs: number): Promise<BeginFireResult>;

  sweepStranded(now: number, staleRunningMs: number, note: string): Promise<number>;
  listRunning(firedAfter: number): Promise<CronFireRecord[]>;

  pruneEnded(opts: { endedBefore: number; keepPerCron: number }): Promise<number>;
  listByCron(cronId: string, opts?: { limit?: number }): Promise<{ runs: CronFireLogEntry[]; total: number }>;
  listByThreadRefs(threadRefs: readonly string[]): Promise<CronFireRecord[]>;
  latestForThread(cronId: string, threadRef: string): Promise<CronFireLogEntry | undefined>;
}

export const FIRE_RETENTION_KEEP_PER_CRON = 100;

interface FireColumn {
  name: string;
  cast: "text" | "bigint";
  value(cronId: string, entry: CronFireLogEntry): string | number | null;
}

const FIRE_COLUMN_DEFS: readonly FireColumn[] = [
  { name: "cron_id", cast: "text", value: (cronId) => cronId },
  { name: "fire_key", cast: "text", value: (_cronId, e) => e.fireKey },
  { name: "thread_ref", cast: "text", value: (_cronId, e) => e.threadRef },
  { name: "session_id", cast: "text", value: (_cronId, e) => e.sessionId ?? null },
  { name: "fired_at", cast: "bigint", value: (_cronId, e) => e.firedAt },
  { name: "scheduled_at", cast: "bigint", value: (_cronId, e) => e.scheduledAt ?? null },
  { name: "ended_at", cast: "bigint", value: (_cronId, e) => e.endedAt ?? null },
  { name: "status", cast: "text", value: (_cronId, e) => e.status ?? null },
  { name: "note", cast: "text", value: (_cronId, e) => (e.note !== undefined ? pgTextSafe(e.note) : null) },
  { name: "reply", cast: "text", value: (_cronId, e) => (e.reply !== undefined ? pgTextSafe(e.reply) : null) },
];

const FIRE_COLUMNS = FIRE_COLUMN_DEFS.map((c) => c.name).join(", ");
const VALUE_COLUMN_DEFS = FIRE_COLUMN_DEFS.filter((c) => c.name !== "cron_id" && c.name !== "fire_key");
const UPSERT_SET = VALUE_COLUMN_DEFS.map((c) => `${c.name} = EXCLUDED.${c.name}`).join(", ");

const HISTORY_FIELDS = [
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

const UPSERT_FIRE = `INSERT INTO cron_fires (${FIRE_COLUMNS})
   VALUES (${FIRE_COLUMN_DEFS.map((_c, i) => `$${i + 1}`).join(", ")})
   ON CONFLICT (tenant_id, cron_id, fire_key) DO UPDATE
     SET ${UPSERT_SET}`;

function fireParams(cronId: string, entry: CronFireLogEntry): unknown[] {
  return FIRE_COLUMN_DEFS.map((c) => c.value(cronId, entry));
}

function rowToRecord(r: Record<string, unknown>): CronFireRecord {
  return { ...rowToEntry(r), cronId: String(r.cron_id) };
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

export function createPostgresCronFireStore(connectionString: string): CronFireStore {
  const { q, query, pool } = createPgPool(connectionString, [
    {
      id: "cron/fires/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS cron_fires(
        cron_id TEXT NOT NULL,
        fire_key TEXT NOT NULL,
        thread_ref TEXT NOT NULL,
        session_id TEXT,
        fired_at BIGINT NOT NULL,
        scheduled_at BIGINT,
        ended_at BIGINT,
        status TEXT,
        note TEXT,
        reply TEXT,
        PRIMARY KEY (cron_id, fire_key)
      )`,
        `CREATE INDEX IF NOT EXISTS idx_cron_fires_thread_ref ON cron_fires (thread_ref)`,
        `CREATE INDEX IF NOT EXISTS idx_cron_fires_cron_fired_at ON cron_fires (cron_id, fired_at DESC)`,
      ],
    },
    ...tenantTables("cron/fires/0002-tenants", [{ table: "cron_fires", primaryKey: "cron_id, fire_key" }]),
    {
      id: "cron/fires/0003-claims",
      statements: [
        claimFunction(
          "claim_stranded_cron_fires",
          "ended bigint, stranded_note text, fired_before bigint",
          `UPDATE cron_fires SET status = 'failed', ended_at = ended, note = stranded_note
              WHERE status = 'running' AND fired_at <= fired_before
              RETURNING tenant_id, jsonb_build_array(cron_id, fire_key)::text`,
        ),
        claimFunction(
          "claim_pruned_cron_fires",
          "keep_per_cron integer, ended_before bigint",
          `DELETE FROM cron_fires cf
              USING (SELECT tenant_id, cron_id, fire_key,
                            ROW_NUMBER() OVER (PARTITION BY tenant_id, cron_id ORDER BY fired_at DESC, fire_key DESC) AS rn
                       FROM cron_fires) ranked
              WHERE cf.tenant_id = ranked.tenant_id AND cf.cron_id = ranked.cron_id AND cf.fire_key = ranked.fire_key
                AND ranked.rn > keep_per_cron
                AND cf.ended_at IS NOT NULL AND cf.ended_at < ended_before
              RETURNING cf.tenant_id, jsonb_build_array(cf.cron_id, cf.fire_key)::text`,
        ),
      ],
    },
    {
      id: "cron/fires/0004-copy-history",
      statements: [
        `DO $copy_history$
         DECLARE
           tenant uuid;
         BEGIN
           IF to_regclass('cron_fire_log') IS NULL THEN
             RETURN;
           END IF;
           IF NOT EXISTS (SELECT 1 FROM cron_fire_log) THEN
             RETURN;
           END IF;
           IF NOT EXISTS (SELECT 1 FROM tenants) THEN
             INSERT INTO tenants DEFAULT VALUES;
           END IF;
           SELECT id INTO tenant FROM tenants ORDER BY created_at, id LIMIT 1;
           INSERT INTO cron_fires (tenant_id, ${FIRE_COLUMNS})
             SELECT tenant, ${HISTORY_FIELDS} FROM cron_fire_log source
           ON CONFLICT (tenant_id, cron_id, fire_key) DO NOTHING;
         END $copy_history$`,
      ],
    },
    {
      id: "cron/fires/0004-drop-legacy-sync",
      statements: [
        `DO $body$ BEGIN
            IF to_regclass('cron_fire_log') IS NOT NULL THEN
              DROP TRIGGER IF EXISTS qm_sync_legacy_cron_fire ON cron_fire_log;
            END IF;
          END $body$`,
        `DROP FUNCTION IF EXISTS qm_sync_legacy_cron_fire()`,
      ],
    },
    { id: "cron/fires/0005-drop-fire-log", statements: ["DROP TABLE IF EXISTS cron_fire_log"] },
  ]);

  return {
    async record(cronId, entry) {
      await query(UPSERT_FIRE, fireParams(cronId, entry));
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
        await client.query(UPSERT_FIRE, fireParams(cronId, entry));
        return { begun: true };
      });
    },
    async sweepStranded(now, staleRunningMs, note) {
      return (await claimRows({ q }, "claim_stranded_cron_fires", [now, pgTextSafe(note), now - staleRunningMs]))
        .length;
    },
    async listRunning(firedAfter) {
      const rows = await q(
        `SELECT ${FIRE_COLUMNS} FROM cron_fires
          WHERE status = 'running' AND fired_at > $1
          ORDER BY fired_at, fire_key`,
        [firedAfter],
      );
      return rows.map(rowToRecord);
    },
    async pruneEnded({ endedBefore, keepPerCron }) {
      return (await claimRows({ q }, "claim_pruned_cron_fires", [keepPerCron, endedBefore])).length;
    },
    async listByCron(cronId, opts) {
      const limit = opts?.limit ?? FIRE_RETENTION_KEEP_PER_CRON;
      if (limit <= 0) {
        const counted = await q(`SELECT COUNT(*)::int AS total FROM cron_fires WHERE cron_id = $1`, [cronId]);
        return { runs: [], total: Number(counted[0]?.total ?? 0) };
      }
      const rows = await q(
        `SELECT ${FIRE_COLUMNS}, COUNT(*) OVER ()::int AS total FROM cron_fires
          WHERE cron_id = $1
          ORDER BY fired_at DESC, fire_key DESC
          LIMIT $2`,
        [cronId, limit],
      );
      const total = rows.length ? Number(rows[0]!.total) : 0;
      return { runs: rows.reverse().map(rowToEntry), total };
    },
    async listByThreadRefs(threadRefs) {
      if (!threadRefs.length) return [];
      const rows = await q(
        `SELECT ${FIRE_COLUMNS} FROM cron_fires
          WHERE thread_ref = ANY($1)
          ORDER BY fired_at, fire_key`,
        [[...threadRefs]],
      );
      return rows.map(rowToRecord);
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
