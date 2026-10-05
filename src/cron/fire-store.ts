import type { CronFireLogEntry } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
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

function fireOrder(a: CronFireLogEntry, b: CronFireLogEntry): number {
  if (a.firedAt !== b.firedAt) return a.firedAt - b.firedAt;
  if (a.fireKey < b.fireKey) return -1;
  if (a.fireKey > b.fireKey) return 1;
  return 0;
}

export function createMemoryCronFireStore(): CronFireStore {
  const byCron = new Map<string, Map<string, CronFireLogEntry>>();
  const firesOf = (cronId: string): Map<string, CronFireLogEntry> => {
    let fires = byCron.get(cronId);
    if (!fires) {
      fires = new Map();
      byCron.set(cronId, fires);
    }
    return fires;
  };
  return {
    async record(cronId, entry) {
      firesOf(cronId).set(entry.fireKey, { ...entry });
    },
    async beginExclusive(cronId, entry, staleRunningMs) {
      const fires = firesOf(cronId);
      const running = [...fires.values()]
        .sort(fireOrder)
        .findLast(
          (e) => e.fireKey !== entry.fireKey && e.status === "running" && entry.firedAt - e.firedAt < staleRunningMs,
        );
      if (running) return { begun: false, running: { ...running } };
      fires.set(entry.fireKey, { ...entry });
      return { begun: true };
    },
    async sweepStranded(now, staleRunningMs, note) {
      let swept = 0;
      for (const fires of byCron.values()) {
        for (const [fireKey, entry] of fires) {
          if (entry.status !== "running" || now - entry.firedAt < staleRunningMs) continue;
          fires.set(fireKey, { ...entry, status: "failed", endedAt: now, note });
          swept += 1;
        }
      }
      return swept;
    },
    async pruneEnded({ endedBefore, keepPerCron }) {
      let pruned = 0;
      for (const fires of byCron.values()) {
        const newestFirst = [...fires.values()].sort(fireOrder).reverse();
        for (const entry of newestFirst.slice(Math.max(keepPerCron, 0))) {
          if (entry.endedAt === undefined || entry.endedAt >= endedBefore) continue;
          fires.delete(entry.fireKey);
          pruned += 1;
        }
      }
      return pruned;
    },
    async listByCron(cronId, opts) {
      const all = [...(byCron.get(cronId)?.values() ?? [])].sort(fireOrder).map((entry) => ({ ...entry }));
      let runs = all;
      if (opts?.limit !== undefined) runs = opts.limit > 0 ? all.slice(-opts.limit) : [];
      return { runs, total: all.length };
    },
    async listByThreadRefs(threadRefs) {
      const wanted = new Set(threadRefs);
      const records: CronFireRecord[] = [];
      for (const [cronId, fires] of byCron) {
        for (const entry of fires.values()) {
          if (wanted.has(entry.threadRef)) records.push({ ...entry, cronId });
        }
      }
      return records.sort(fireOrder);
    },
    async latestForThread(cronId, threadRef) {
      const matches = [...(byCron.get(cronId)?.values() ?? [])].filter((e) => e.threadRef === threadRef);
      const latest = matches.sort(fireOrder).at(-1);
      return latest ? { ...latest } : undefined;
    },
  };
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

const UPSERT_FIRE = `INSERT INTO cron_fires (${FIRE_COLUMNS})
   VALUES (${FIRE_COLUMN_DEFS.map((_c, i) => `$${i + 1}`).join(", ")})
   ON CONFLICT (cron_id, fire_key) DO UPDATE
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
      const result = await query(
        `UPDATE cron_fires
            SET status = 'failed', ended_at = $1, note = $2
          WHERE status = 'running' AND fired_at <= $3`,
        [now, pgTextSafe(note), now - staleRunningMs],
      );
      return result.rowCount;
    },
    async pruneEnded({ endedBefore, keepPerCron }) {
      return withPgTransaction(await pool(), async (client) => {
        const result = await client.query(
          `DELETE FROM cron_fires cf
            USING (SELECT cron_id, fire_key,
                          ROW_NUMBER() OVER (PARTITION BY cron_id ORDER BY fired_at DESC, fire_key DESC) AS rn
                     FROM cron_fires) ranked
            WHERE cf.cron_id = ranked.cron_id AND cf.fire_key = ranked.fire_key
              AND ranked.rn > $1
              AND cf.ended_at IS NOT NULL AND cf.ended_at < $2
            RETURNING cf.cron_id, cf.fire_key`,
          [keepPerCron, endedBefore],
        );
        return result.rowCount ?? 0;
      });
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
