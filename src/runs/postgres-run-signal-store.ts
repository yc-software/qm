import { ABSURD_MIGRATION, absurdQueueMigration, DURABLE_RETRY_OPTIONS_SQL } from "../durable/schema.ts";
import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import type { RunSignal, RunSignalKind, RunSignalStore } from "./run-signal-store.ts";

const CHANNEL = "run_signals";

function toSignals(rows: Rows): RunSignal[] {
  return rows
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((r): RunSignal =>
      r.payload != null
        ? (r.payload as RunSignal)
        : {
            kind: r.kind as RunSignalKind,
            ...(r.text != null ? { text: r.text as string } : {}),
          },
    );
}

export function createPostgresRunSignalStore(connectionString: string): RunSignalStore {
  const pg = createPgPool(connectionString, [
    ABSURD_MIGRATION,
    absurdQueueMigration("qm_handoffs"),
    {
      id: "runs/signals/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS run_signals(
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT,
        payload JSONB,
        created_at BIGINT NOT NULL,
        consumed_at BIGINT
      )`,
        `ALTER TABLE run_signals ADD COLUMN IF NOT EXISTS payload JSONB`,
        `CREATE INDEX IF NOT EXISTS idx_run_signals_pending ON run_signals(run_id) WHERE consumed_at IS NULL`,
      ],
    },
    {
      id: "runs/signals/0002",
      statements: [
        `ALTER TABLE run_signals ADD COLUMN IF NOT EXISTS dedupe_key TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS run_signals_by_dedupe_key ON run_signals(dedupe_key) WHERE dedupe_key IS NOT NULL`,
      ],
    },
    {
      id: "runs/signals/0003-workflows",
      statements: [
        `SELECT absurd.spawn_task('qm_handoffs','signal.replay',jsonb_build_object('runId',run_id),
        jsonb_build_object('idempotency_key','signal:'||id)||${DURABLE_RETRY_OPTIONS_SQL}) FROM run_signals WHERE consumed_at IS NULL`,
      ],
    },
  ]);
  const q = pg.query;

  const listeners = new Map<string, Set<() => void>>();
  let stopListening: (() => Promise<void>) | null = null;
  let closed = false;
  let cleanup = Promise.resolve();

  function ring(runId: string): void {
    for (const cb of listeners.get(runId) ?? []) cb();
  }

  function dropListenClient() {
    const stop = stopListening;
    stopListening = null;
    if (stop) cleanup = Promise.all([cleanup, stop()]).then(() => {});
  }

  function ensureListening() {
    if (closed || stopListening || listeners.size === 0) return;
    stopListening = subscribePostgresChannel(connectionString, CHANNEL, ring, () => {
      for (const runId of listeners.keys()) ring(runId);
    });
  }

  return {
    async send(runId, signal) {
      const { rows } = await q(
        `WITH ins AS (
           INSERT INTO run_signals(run_id, kind, text, payload, created_at, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
           RETURNING id
         )
         SELECT pg_notify('${CHANNEL}', $1),absurd.spawn_task('qm_handoffs','signal.replay',
           jsonb_build_object('runId',$1::text),jsonb_build_object('idempotency_key','signal:'||id)||${DURABLE_RETRY_OPTIONS_SQL}) FROM ins`,
        [runId, signal.kind, signal.text ?? null, JSON.stringify(signal), Date.now(), signal.dedupeKey ?? null],
      );
      return rows.length > 0;
    },

    async hasDedupeKey(dedupeKey) {
      const { rows } = await q(`SELECT 1 FROM run_signals WHERE dedupe_key = $1 LIMIT 1`, [dedupeKey]);
      return rows.length > 0;
    },

    async steerAuthors(runId) {
      const { rows } = await q(
        `SELECT payload FROM run_signals WHERE run_id=$1 AND kind='steer' AND payload IS NOT NULL`,
        [runId],
      );
      const ids = rows
        .map((r) => (r.payload as RunSignal).request?.actor?.externalId)
        .filter((id): id is string => typeof id === "string" && id !== "");
      return [...new Set(ids)];
    },

    async pending(runId) {
      const { rows } = await q(
        "SELECT id, kind, text, payload FROM run_signals WHERE run_id=$1 AND consumed_at IS NULL ORDER BY id",
        [runId],
      );
      return rows.map((row) => ({ id: String(row.id), signal: toSignals([row])[0]! }));
    },
    async acknowledge(runId, id) {
      await q("UPDATE run_signals SET consumed_at=$3 WHERE run_id=$1 AND id=$2 AND consumed_at IS NULL", [
        runId,
        id,
        Date.now(),
      ]);
    },
    async takePending(runId) {
      const { rows } = await q(
        `UPDATE run_signals SET consumed_at=$2
         WHERE run_id=$1 AND consumed_at IS NULL
         RETURNING id, kind, text, payload`,
        [runId, Date.now()],
      );
      return toSignals(rows);
    },

    async pendingRunIds() {
      const { rows } = await q(`SELECT DISTINCT run_id FROM run_signals WHERE consumed_at IS NULL`);
      return rows.map((r) => r.run_id as string);
    },

    async prune(olderThanMs) {
      await q(`DELETE FROM run_signals WHERE consumed_at IS NOT NULL AND consumed_at < $1`, [Date.now() - olderThanMs]);
    },

    onSignal(runId, cb) {
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      ensureListening();
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(runId);
        if (listeners.size === 0) dropListenClient();
      };
    },

    async close() {
      closed = true;
      dropListenClient();
      await cleanup;
      await pg.close();
    },
  };
}
