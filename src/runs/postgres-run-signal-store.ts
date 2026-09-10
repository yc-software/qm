import { createPgPool, type PoolClient, type Rows } from "../persistence/pg-pool.ts";
import { swallowAs } from "../util/errors.ts";
import type { RunSignal, RunSignalKind, RunSignalStore } from "./run-signal-store.ts";

const CHANNEL = "run_signals";
const RECONNECT_DELAY_MS = 1_000;

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
      const client = await (await pg.sessionPool()).connect();
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
      const { rows } = await q(
        `WITH ins AS (
           INSERT INTO run_signals(run_id, kind, text, payload, created_at, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
           RETURNING id
         )
         SELECT pg_notify('${CHANNEL}', $1) FROM ins`,
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

    async takePending(runId) {
      const { rows } = await q(
        `UPDATE run_signals SET consumed_at=$2
         WHERE run_id=$1 AND consumed_at IS NULL
         RETURNING id, kind, text, payload`,
        [runId, Date.now()],
      );
      return toSignals(rows);
    },

    async takeLive(runId) {
      const { rows } = await q(
        `WITH taken AS (
           UPDATE run_signals SET consumed_at=$2
           WHERE run_id=$1 AND consumed_at IS NULL AND kind <> 'abort'
           RETURNING id, kind, text, payload
         )
         SELECT id, kind, text, payload FROM taken
         UNION ALL
         SELECT id, kind, text, payload FROM run_signals
         WHERE run_id=$1 AND kind='abort' AND consumed_at IS NULL`,
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
      };
    },

    async close() {
      closed = true;
      dropListenClient();
      await pg.close();
    },
  };
}
