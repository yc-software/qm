import { randomUUID } from "node:crypto";
import { createPgPool, type PoolClient, type Rows } from "../persistence/pg-pool.ts";
import { swallowAs } from "../util/errors.ts";
import type {
  RunSignal,
  RunSignalKind,
  SavedRunSignal,
  SignalClaim,
  RunSignalStore,
  RunSignalStoreOptions,
  SignalAdmission,
} from "./run-signal-store.ts";

const CHANNEL = "run_signals";
const RECONNECT_DELAY_MS = 1_000;

function toSignals(rows: Rows): SavedRunSignal[] {
  return rows
    .sort((first, second) => Number(first.id) - Number(second.id))
    .map((row) => ({
      ...(row.payload != null
        ? (row.payload as RunSignal)
        : { kind: row.kind as RunSignalKind, ...(row.text != null ? { text: row.text as string } : {}) }),
      ...(row.transferring ? { transferring: true } : {}),
      id: String(row.id),
      runId: row.run_id as string,
      ...(row.delivery_run_id ? { deliveryRunId: row.delivery_run_id as string } : {}),
    }));
}

export function createPostgresRunSignalStore(
  connectionString: string,
  opts: RunSignalStoreOptions = {},
): RunSignalStore {
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
    {
      id: "runs/signals/0003",
      statements: [
        `CREATE TABLE IF NOT EXISTS run_signal_readers(
          run_id TEXT PRIMARY KEY, token TEXT NOT NULL, closed_at BIGINT
        )`,
      ],
    },
    {
      id: "runs/signals/0004",
      statements: [
        `ALTER TABLE run_signals ADD COLUMN claim_token TEXT, ADD COLUMN claim_reader_token TEXT, ADD COLUMN claim_expires_at BIGINT, ADD COLUMN delivery_run_id TEXT`,
        `ALTER TABLE run_signal_readers ADD COLUMN lease_token TEXT`,
      ],
    },
    {
      id: "runs/signals/0005",
      statements: [`ALTER TABLE run_signals ADD COLUMN transferring BOOLEAN NOT NULL DEFAULT FALSE`],
    },
  ]);
  const q = pg.query;

  async function withReader<T>(runId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await (await pg.pool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["run-signal-reader:" + runId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

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

  const claimFence = `id=$1 AND claim_token=$2 AND consumed_at IS NULL AND ($5 OR claim_expires_at>$3)
    AND (claim_reader_token IS NULL OR EXISTS (SELECT 1 FROM run_signal_readers reader
      WHERE reader.run_id=run_signals.run_id AND reader.token=claim_reader_token AND reader.closed_at IS NULL))`;
  async function updateClaim(
    claim: SignalClaim,
    assignment: string,
    extra: unknown[],
    accepted = false,
  ): Promise<boolean> {
    return withReader(claim.signal.runId, async (client) => {
      const reader = (await client.query(`SELECT * FROM run_signal_readers WHERE run_id=$1`, [claim.signal.runId]))
        .rows[0];
      const record = (await client.query(`SELECT claim_reader_token FROM run_signals WHERE id=$1`, [claim.signal.id]))
        .rows[0];
      if (
        !accepted &&
        record?.claim_reader_token &&
        reader?.lease_token &&
        opts.readerLeaseValid &&
        !(await opts.readerLeaseValid(claim.signal.runId, reader.lease_token as string))
      )
        return false;
      const result = await client.query(`UPDATE run_signals SET ${assignment} WHERE ${claimFence}`, [
        claim.signal.id,
        claim.token,
        Date.now(),
        ...extra,
        accepted,
      ]);
      return !!result.rowCount;
    });
  }
  return {
    async send(runId, signal, options) {
      return withReader<SignalAdmission>(runId, async (client) => {
        if (signal.dedupeKey) {
          const duplicate = await client.query(`SELECT * FROM run_signals WHERE dedupe_key=$1`, [signal.dedupeKey]);
          if (duplicate.rows.length) return { status: "duplicate", signal: toSignals(duplicate.rows)[0]! };
        }
        if (signal.kind === "steer" && !options?.allowClosed) {
          const reader = await client.query(
            `SELECT 1 FROM run_signal_readers WHERE run_id=$1 AND closed_at IS NOT NULL`,
            [runId],
          );
          if (reader.rows.length) return { status: "closed" };
        }
        const { rows } = await client.query(
          `INSERT INTO run_signals(run_id, kind, text, payload, created_at, dedupe_key, transferring) VALUES ($1,$2,$3,$4,$5,$6,EXISTS (SELECT 1 FROM run_signal_readers WHERE run_id=$1 AND closed_at IS NOT NULL))
           ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
          [runId, signal.kind, signal.text ?? null, JSON.stringify(signal), Date.now(), signal.dedupeKey ?? null],
        );
        if (!rows.length) {
          const duplicate = await client.query(`SELECT * FROM run_signals WHERE dedupe_key=$1`, [signal.dedupeKey]);
          return { status: "duplicate", signal: toSignals(duplicate.rows)[0]! };
        }
        await client.query(`SELECT pg_notify('${CHANNEL}', $1)`, [runId]);
        return { status: "sent", signal: toSignals(rows)[0]! };
      });
    },
    async get(id) {
      const { rows } = await q(`SELECT * FROM run_signals WHERE id=$1`, [id]);
      return toSignals(rows)[0] ?? null;
    },
    async getByDedupeKey(key) {
      const { rows } = await q(`SELECT * FROM run_signals WHERE dedupe_key=$1`, [key]);
      return toSignals(rows)[0] ?? null;
    },
    async pending(runId) {
      const { rows } = await q(`SELECT * FROM run_signals WHERE run_id=$1 AND consumed_at IS NULL ORDER BY id`, [
        runId,
      ]);
      return toSignals(rows);
    },
    async claim(runId, owner, ttlMs) {
      return withReader(runId, async (client) => {
        const reader = (await client.query(`SELECT * FROM run_signal_readers WHERE run_id=$1`, [runId])).rows[0];
        if (
          "readerToken" in owner &&
          reader?.lease_token &&
          opts.readerLeaseValid &&
          !(await opts.readerLeaseValid(runId, reader.lease_token as string))
        )
          return null;
        if ("readerToken" in owner) {
          if (reader?.token !== owner.readerToken || reader.closed_at !== null) return null;
        }
        const skipIds = "terminal" in owner ? (owner.skipIds ?? []) : [];
        const record = (
          await client.query(
            `SELECT * FROM run_signals WHERE run_id=$1 AND consumed_at IS NULL AND kind='steer' AND NOT (id::text = ANY($2::text[])) AND (NOT $3 OR NOT transferring) ORDER BY id LIMIT 1 FOR UPDATE`,
            [runId, skipIds, "readerToken" in owner],
          )
        ).rows[0];
        if ("terminal" in owner && !owner.terminal && reader?.closed_at == null && !record?.transferring) return null;
        if (record?.claim_token && Number(record.claim_expires_at) > Date.now()) return null;
        if ("terminal" in owner && owner.terminal) {
          await client.query(`UPDATE run_signal_readers SET closed_at=COALESCE(closed_at,$2) WHERE run_id=$1`, [
            runId,
            Date.now(),
          ]);
          await client.query(
            `UPDATE run_signals SET consumed_at=$2 WHERE run_id=$1 AND consumed_at IS NULL AND kind='abort'`,
            [runId, Date.now()],
          );
        }
        if (!record) return null;
        const token = randomUUID();
        await client.query(
          `UPDATE run_signals SET claim_token=$2, claim_reader_token=$3, claim_expires_at=$4, transferring=transferring OR $5 WHERE id=$1`,
          [
            record.id,
            token,
            "readerToken" in owner ? owner.readerToken : null,
            Date.now() + ttlMs,
            "terminal" in owner,
          ],
        );
        return {
          signal: toSignals([{ ...record, transferring: record.transferring || "terminal" in owner }])[0]!,
          token,
        };
      });
    },
    async renew(claim, ttlMs) {
      return updateClaim(claim, "claim_expires_at=$4", [Date.now() + ttlMs]);
    },
    async ack(claim, deliveryRunId) {
      return updateClaim(
        claim,
        "consumed_at=$3, delivery_run_id=$4, claim_token=NULL, claim_reader_token=NULL, claim_expires_at=NULL",
        [deliveryRunId ?? null],
        true,
      );
    },
    async release(claim) {
      await q(
        `UPDATE run_signals SET claim_token=NULL, claim_reader_token=NULL, claim_expires_at=NULL WHERE id=$1 AND claim_token=$2`,
        [claim.signal.id, claim.token],
      );
    },
    async aborted(runId, readerToken) {
      const { rows } = await q(
        `SELECT 1 FROM run_signals WHERE run_id=$1 AND kind='abort' AND consumed_at IS NULL
        AND EXISTS (SELECT 1 FROM run_signal_readers WHERE run_id=$1 AND token=$2 AND closed_at IS NULL) LIMIT 1`,
        [runId, readerToken],
      );
      return !!rows.length;
    },

    async openReader(runId, token, leaseToken) {
      await withReader(runId, async (client) => {
        if (leaseToken && opts.readerLeaseValid && !(await opts.readerLeaseValid(runId, leaseToken)))
          throw new Error("run execution lease lost");
        const active = await client.query(
          `SELECT 1 FROM run_signals WHERE run_id=$1 AND claim_reader_token IS NOT NULL AND claim_reader_token<>$2 AND claim_expires_at>$3 LIMIT 1`,
          [runId, token, Date.now()],
        );
        if (active.rows.length) throw new Error("signal reader still accepting");
        await client.query(
          `INSERT INTO run_signal_readers(run_id, token, lease_token) VALUES ($1,$2,$3)
          ON CONFLICT (run_id) DO UPDATE SET token=EXCLUDED.token, lease_token=EXCLUDED.lease_token, closed_at=NULL`,
          [runId, token, leaseToken ?? null],
        );
      });
    },

    async closeReader(runId, token) {
      const { rowCount } = await withReader(runId, (client) =>
        client.query(`UPDATE run_signal_readers SET closed_at=$3 WHERE run_id=$1 AND token=$2 AND closed_at IS NULL`, [
          runId,
          token,
          Date.now(),
        ]),
      );
      if (rowCount) await opts.onReaderClosed?.(runId);
    },

    async readerClosed(runId) {
      const { rows } = await q(`SELECT 1 FROM run_signal_readers WHERE run_id=$1 AND closed_at IS NOT NULL`, [runId]);
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

    async pendingRunIds() {
      const { rows } = await q(`SELECT DISTINCT run_id FROM run_signals WHERE consumed_at IS NULL`);
      return rows.map((r) => r.run_id as string);
    },

    async prune(olderThanMs) {
      await q(`DELETE FROM run_signals WHERE consumed_at IS NOT NULL AND consumed_at < $1`, [Date.now() - olderThanMs]);
      const cutoff = Date.now() - olderThanMs;
      const { rows } = await q(`SELECT run_id FROM run_signal_readers WHERE closed_at < $1`, [cutoff]);
      for (const row of rows) {
        if (await opts.readerFinished?.(row.run_id as string))
          await q(`DELETE FROM run_signal_readers WHERE run_id=$1 AND closed_at < $2`, [row.run_id, cutoff]);
      }
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
