import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { EnqueueInput, EnqueueResult, ReapEvent, Run, RunDeliveryState, RunStore } from "./run-store.ts";
import { isTerminal } from "./run-store.ts";
import type { LedgerBegin, ToolLedger } from "./tool-ledger.ts";

export interface PostgresRuntime {
  runs: RunStore;
  ledger: ToolLedger;
  close(): Promise<void>;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

function rowToRun(r: Record<string, unknown>): Run {
  const request = JSON.parse(r.request as string) as OrchestratorInput;
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    status: r.status as Run["status"],
    request: { ...request, origin: resolveTurnOrigin(request) },
    result: r.result != null ? (JSON.parse(r.result as string) as TurnResult) : null,
    deliveryState: r.delivery_state != null ? (JSON.parse(r.delivery_state as string) as RunDeliveryState) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  };
}

export function createPostgresRunStore(connectionString: string, opts?: { maxClaims?: number }): PostgresRuntime {
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY;
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const { query: q, close: closePool } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
        request TEXT NOT NULL, result TEXT, idempotency_key TEXT UNIQUE,
        attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
        lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT,
        created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT
      )`,
    `ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery_state TEXT`,
    `ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_attempts INT NOT NULL DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
    `CREATE INDEX IF NOT EXISTS idx_runs_status_created_seq ON runs(status, created_at, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_session_active_created
        ON runs(session_id, created_at DESC) WHERE status IN ('pending','running')`,
    `DROP INDEX IF EXISTS idx_runs_status_priority_created`,
    `UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL
      WHERE status='running' AND id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY started_at ASC NULLS LAST, id) AS rn
          FROM runs WHERE status='running'
        ) dup WHERE dup.rn > 1
      )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_session ON runs(session_id) WHERE status='running'`,
    `CREATE TABLE IF NOT EXISTS tool_calls(
        run_id TEXT NOT NULL, attempt INT NOT NULL DEFAULT 1, call_index INT NOT NULL,
        output TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY(run_id, attempt, call_index)
      )`,
    `ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1`,
    `ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_pkey`,
    `ALTER TABLE tool_calls ADD PRIMARY KEY (run_id, attempt, call_index)`,
  ]);

  async function getRun(id: string): Promise<Run | null> {
    const { rows } = await q("SELECT * FROM runs WHERE id = $1", [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }
  const terminalListeners: Array<(run: Run) => void> = [];
  function settle(run: Run | null): void {
    if (!run || !isTerminal(run.status)) return;
    events.emit(run.id, run);
    for (const listener of terminalListeners) listener(run);
  }
  async function retire(
    run: Run,
    error: string,
    retry: boolean,
    opts?: { ifExpiredAt?: number; countsAsError?: boolean },
  ): Promise<{ requeued: boolean; applied: boolean }> {
    const ifExpiredAt = opts?.ifExpiredAt ?? null;
    const countsAsError = opts?.countsAsError ?? false;
    const errorAttemptsAfter = run.errorAttempts + (countsAsError ? 1 : 0);
    const overClaimed = run.attempts >= maxClaims;
    if (retry && errorAttemptsAfter < run.maxAttempts && !overClaimed) {
      const { rowCount } = await q(
        `UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL,
           error_attempts=error_attempts+$4
         WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3)`,
        [run.id, run.leaseToken, ifExpiredAt, countsAsError ? 1 : 0],
      );
      return { requeued: rowCount > 0, applied: rowCount > 0 };
    }
    const reason =
      !countsAsError && overClaimed && retry && errorAttemptsAfter < run.maxAttempts
        ? `run parked after ${run.attempts} claims without completing (suspected crash loop)`
        : error;
    const result: TurnResult = { status: "failed", sessionId: run.sessionId, reason };
    const { rowCount } = await q(
      `UPDATE runs SET status='failed', result=$4, lease_token=NULL, lease_expires_at=NULL, worker_id=NULL, finished_at=$5,
         error_attempts=error_attempts+$6
       WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3)`,
      [run.id, run.leaseToken, ifExpiredAt, JSON.stringify(result), Date.now(), countsAsError ? 1 : 0],
    );
    if (rowCount > 0) settle(await getRun(run.id));
    return { requeued: false, applied: rowCount > 0 };
  }

  const runs: RunStore = {
    ...(Number.isFinite(maxClaims) ? { maxClaims } : {}),

    async enqueue({ sessionId, request, dedupKey, maxAttempts = 3 }: EnqueueInput): Promise<EnqueueResult> {
      const id = randomUUID();
      const { rows: inserted } = await q(
        `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at)
         VALUES ($1,$2,'pending',$3,$4,0,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [id, sessionId, JSON.stringify(request), dedupKey ?? null, maxAttempts, Date.now()],
      );
      if (inserted[0]) return { run: rowToRun(inserted[0]), deduped: false };
      const { rows } = await q("SELECT * FROM runs WHERE idempotency_key = $1", [dedupKey]);
      return { run: rowToRun(rows[0]!), deduped: true };
    },

    async claim(workerId, ttlMs): Promise<Run | null> {
      const token = randomUUID();
      const now = Date.now();
      try {
        const { rows } = await q(
          `UPDATE runs SET status='running', lease_token=$1, lease_expires_at=$2, worker_id=$3,
             attempts=attempts+1, started_at=COALESCE(started_at,$4)
           WHERE id = (
             SELECT id FROM runs WHERE status='pending'
               AND session_id NOT IN (SELECT session_id FROM runs WHERE status='running')
             ORDER BY created_at ASC, seq ASC FOR UPDATE SKIP LOCKED LIMIT 1
           ) RETURNING *`,
          [token, now + ttlMs, workerId, now],
        );
        return rows[0] ? rowToRun(rows[0]) : null;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async claimById(runId, workerId, ttlMs): Promise<Run | null> {
      const token = randomUUID();
      const now = Date.now();
      try {
        const { rows } = await q(
          `UPDATE runs SET status='running', lease_token=$1, lease_expires_at=$2, worker_id=$3,
             attempts=attempts+1, started_at=COALESCE(started_at,$4)
           WHERE id = (
             SELECT id FROM runs WHERE id=$5 AND status='pending'
               AND session_id NOT IN (SELECT session_id FROM runs WHERE status='running')
             FOR UPDATE SKIP LOCKED LIMIT 1
           ) RETURNING *`,
          [token, now + ttlMs, workerId, now, runId],
        );
        return rows[0] ? rowToRun(rows[0]) : null;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async heartbeat(runId, leaseToken, ttlMs): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET lease_expires_at=$1 WHERE id=$2 AND lease_token=$3 AND status='running'",
        [Date.now() + ttlMs, runId, leaseToken],
      );
      return rowCount > 0;
    },

    async releaseLease(runId, leaseToken): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",
        [runId, leaseToken],
      );
      return rowCount > 0;
    },

    async complete(runId, leaseToken, result): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET status='done', result=$1, lease_token=NULL, lease_expires_at=NULL, finished_at=$2 WHERE id=$3 AND lease_token=$4",
        [JSON.stringify(result), Date.now(), runId, leaseToken],
      );
      if (rowCount > 0) {
        settle(await getRun(runId));
        return true;
      }
      return false;
    },

    async fail(runId, leaseToken, error, opts): Promise<{ requeued: boolean }> {
      const run = await getRun(runId);
      if (!run || run.leaseToken !== leaseToken) return { requeued: false };
      return { requeued: (await retire(run, error, opts?.retry !== false, { countsAsError: true })).requeued };
    },

    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean> {
      const { rowCount } =
        leaseToken === null
          ? await q("UPDATE runs SET delivery_state=$1 WHERE id=$2", [JSON.stringify(state), runId])
          : await q("UPDATE runs SET delivery_state=$1 WHERE id=$2 AND lease_token=$3", [
              JSON.stringify(state),
              runId,
              leaseToken,
            ]);
      return rowCount > 0;
    },

    onTerminal(listener): void {
      terminalListeners.push(listener);
    },

    get: getRun,

    async activeForThread(sessionId: string): Promise<Run | null> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
        [sessionId],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async inFlightForThread(sessionId: string): Promise<Run[]> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY created_at ASC, seq ASC",
        [sessionId],
      );
      return rows.map(rowToRun);
    },

    async withdraw(runId: string): Promise<boolean> {
      const { rowCount } = await q("DELETE FROM runs WHERE id = $1 AND status = 'pending'", [runId]);
      return (rowCount ?? 0) > 0;
    },

    async activeSessionIds(): Promise<string[]> {
      const { rows } = await q("SELECT DISTINCT session_id FROM runs WHERE status IN ('pending','running')");
      return rows.map((r) => r.session_id as string);
    },

    async list({ limit = 200 }: { limit?: number } = {}): Promise<Run[]> {
      const { rows } = await q("SELECT * FROM runs ORDER BY created_at DESC LIMIT $1", [limit]);
      return rows.map(rowToRun);
    },

    async reapExpired(
      onRetired?: (sessionIds: string[]) => Promise<void>,
      opts?: { maxAgeMs?: number; onReap?: (event: ReapEvent) => void },
    ): Promise<{ requeued: number; parked: number }> {
      const now = Date.now();
      const { rows } = await q(
        "SELECT * FROM runs WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1",
        [now],
      );
      const expired = rows.map(rowToRun);
      let requeued = 0;
      let parked = 0;
      const retiredSessionIds: string[] = [];
      for (const run of expired) {
        const tooOld = opts?.maxAgeMs !== undefined && run.startedAt !== null && now - run.startedAt > opts.maxAgeMs;
        const reason = tooOld ? "run exceeded max age (reaped)" : "lease expired (reaped)";
        const r = await retire(run, reason, !tooOld, { ifExpiredAt: now });
        if (!r.applied) continue;
        if (r.requeued) requeued++;
        else parked++;
        retiredSessionIds.push(run.sessionId);
        opts?.onReap?.({
          runId: run.id,
          sessionId: run.sessionId,
          workerId: run.workerId,
          attempts: run.attempts,
          errorAttempts: run.errorAttempts,
          outcome: r.requeued ? "requeued" : "parked",
        });
      }
      if (onRetired && retiredSessionIds.length) await onRetired(retiredSessionIds);
      return { requeued, parked };
    },

    waitFor(runId, timeoutMs = 60_000): Promise<Run> {
      return new Promise<Run>((resolve, reject) => {
        let done = false;
        const finish = (r: Run): void => {
          if (done) return;
          done = true;
          clearInterval(poll);
          events.off(runId, onSettle);
          resolve(r);
        };
        function onSettle(r: Run): void {
          finish(r);
        }
        events.once(runId, onSettle);
        const poll = setInterval(() => {
          void getRun(runId).then((r) => {
            if (r && isTerminal(r.status)) finish(r);
          });
        }, 250);
        poll.unref?.();
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          clearInterval(poll);
          events.off(runId, onSettle);
          reject(new Error(`run ${runId} did not finish within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      });
    },

    async close(): Promise<void> {
      await closePool();
    },
  };

  const ledger: ToolLedger = {
    async begin(runId, attempt, callIndex): Promise<LedgerBegin> {
      const { rows } = await q("SELECT output FROM tool_calls WHERE run_id=$1 AND attempt=$2 AND call_index=$3", [
        runId,
        attempt,
        callIndex,
      ]);
      return rows[0] ? { cached: true, output: rows[0].output as string } : { cached: false };
    },
    async record(runId, attempt, callIndex, output): Promise<void> {
      await q(
        "INSERT INTO tool_calls(run_id, attempt, call_index, output, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [runId, attempt, callIndex, output, Date.now()],
      );
    },
  };

  return { runs, ledger, close: () => runs.close!() };
}
