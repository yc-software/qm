import { createPgPool, type PoolClient } from "../persistence/pg-pool.ts";
import { swallowAs } from "../util/errors.ts";
import type { RunSignal, RunSignalKind, RunSignalStore } from "./run-signal-store.ts";

const CHANNEL = "run_signals";
const RECONNECT_DELAY_MS = 1_000;

export function createPostgresRunSignalStore(connectionString: string): RunSignalStore {
  const pg = createPgPool(connectionString, [
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
  ]);
  const q = pg.query;

  const listeners = new Map<string, Set<() => void>>();
  let listenClient: PoolClient | null = null;
  let connecting = false;
  let closed = false;

  function ring(runId: string): void {
    for (const cb of listeners.get(runId) ?? []) cb();
  }

  function dropListenClient(): void {
    const client = listenClient;
    listenClient = null;
    if (client) client.release(true);
  }

  function ensureListening(): void {
    if (closed || connecting || listenClient || listeners.size === 0) return;
    connecting = true;
    void (async () => {
      const client = await (await pg.pool()).connect();
      client.on("notification", (msg) => {
        if (msg.channel === CHANNEL && msg.payload) ring(msg.payload);
      });
      client.on("error", () => {
        dropListenClient();
        setTimeout(() => {
          ensureListening();
          for (const runId of listeners.keys()) ring(runId);
        }, RECONNECT_DELAY_MS).unref?.();
      });
      await client.query(`LISTEN ${CHANNEL}`);
      listenClient = client;
    })()
      .catch(swallowAs("run-signals: listen connect", undefined))
      .finally(() => {
        connecting = false;
        if (closed) dropListenClient();
        else if (!listenClient && listeners.size > 0) {
          setTimeout(() => ensureListening(), RECONNECT_DELAY_MS).unref?.();
        }
      });
  }

  return {
    async send(runId, signal) {
      await q(
        `WITH ins AS (
           INSERT INTO run_signals(run_id, kind, text, payload, created_at) VALUES ($1,$2,$3,$4,$5)
         )
         SELECT pg_notify('${CHANNEL}', $1)`,
        [runId, signal.kind, signal.text ?? null, JSON.stringify(signal), Date.now()],
      );
    },

    async takePending(runId) {
      const { rows } = await q(
        `UPDATE run_signals SET consumed_at=$2
         WHERE run_id=$1 AND consumed_at IS NULL
         RETURNING id, kind, text, payload`,
        [runId, Date.now()],
      );
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
      };
    },

    async close() {
      closed = true;
      dropListenClient();
      await pg.close();
    },
  };
}
