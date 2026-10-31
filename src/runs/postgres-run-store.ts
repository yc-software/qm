import { turnFenceHeld } from "../turns/turn-fence.ts";
import { EventEmitter } from "node:events";
import { errMessage } from "../util/errors.ts";
import { createPgPool, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { Run, RunDeliveryState, RunStop, RunStore } from "./run-store.ts";
import type { RunPriority } from "./run-store.ts";
import { isTerminal } from "./run-store.ts";

export type RunRows = Omit<RunStore, "enqueue" | "withdraw" | "leaseHeld">;

export interface PostgresRuntime {
  runs: RunRows;
  close(): Promise<void>;
}

export function rowToRun(r: Record<string, unknown>): Run {
  const request = JSON.parse(r.request as string) as OrchestratorInput;
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    status: r.status as Run["status"],
    request: { ...request, origin: resolveTurnOrigin(request) },
    result: r.result != null ? (JSON.parse(r.result as string) as TurnResult) : null,
    deliveryState: r.delivery_state != null ? (JSON.parse(r.delivery_state as string) as RunDeliveryState) : null,
    turnUserSeq: r.turn_user_seq != null ? Number(r.turn_user_seq) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    priority: Number(r.claim_priority) as RunPriority,
    preemptions: Number(r.preemptions),
    leaseToken: (r.lease_token as string | null) ?? null,
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    lastStop: r.last_stop != null ? (JSON.parse(r.last_stop as string) as RunStop) : null,
    absurdTaskId: r.absurd_task_id == null ? null : String(r.absurd_task_id),
    absurdRunId: r.absurd_run_id == null ? null : String(r.absurd_run_id),
  };
}

const PREVIOUS_SCHEMA = "runs/store/0010-drop-turn-metrics";

export const RUN_STORE_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "runs/store/0011-base-schema",
    expectedChecksum: "77ca2d1c3ec5253374c0eadbf47d91d53c6d2c3fc7232079b33006bc9233a24e",
    statements: [
      `SET LOCAL lock_timeout = '60s'`,
      `DO $base_schema$
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${PREVIOUS_SCHEMA}') THEN
    RETURN;
  END IF;
  IF to_regclass('runs') IS NOT NULL THEN
    RAISE EXCEPTION 'This database has a runs table from a release older than ${PREVIOUS_SCHEMA}. Start a release that applies ${PREVIOUS_SCHEMA} but predates the base schema, then upgrade.';
  END IF;
  CREATE TABLE runs(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    request TEXT NOT NULL,
    result TEXT,
    idempotency_key TEXT UNIQUE,
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    lease_token TEXT,
    lease_expires_at BIGINT,
    worker_id TEXT,
    created_at BIGINT NOT NULL,
    started_at BIGINT,
    finished_at BIGINT,
    delivery_state TEXT,
    error_attempts INT NOT NULL DEFAULT 0,
    seq BIGSERIAL,
    turn_user_seq BIGINT,
    retry_after BIGINT NOT NULL DEFAULT 0,
    returned_at BIGINT,
    last_stop TEXT,
    claim_priority SMALLINT NOT NULL DEFAULT 2,
    preemptions INT NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_runs_status_created ON runs(status, created_at);
  CREATE INDEX idx_runs_status_created_seq ON runs(status, created_at, seq);
  CREATE INDEX idx_runs_session_active_created ON runs(session_id, created_at DESC) WHERE status IN ('pending', 'running');
  CREATE UNIQUE INDEX idx_runs_one_running_per_session ON runs(session_id) WHERE status = 'running';
  CREATE INDEX idx_runs_pending_child_returns ON runs(id)
    WHERE status IN ('done', 'failed') AND returned_at IS NULL AND session_id LIKE 'agent:main:subagent:%';
  CREATE INDEX idx_runs_session_created_seq ON runs(session_id, created_at DESC, seq DESC);
  CREATE INDEX idx_runs_created ON runs(created_at DESC);
  CREATE INDEX idx_runs_terminal_finished ON runs(finished_at, id) WHERE status IN ('done', 'failed');
  CREATE INDEX idx_runs_pending_priority ON runs(claim_priority, created_at, seq) WHERE status = 'pending';
END $base_schema$`,
      `DROP TABLE IF EXISTS tool_calls`,
    ],
  },
  {
    id: "runs/store/0012-absurd-turns",
    statements: [
      `SET LOCAL lock_timeout = '60s'`,
      `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_task_id UUID`,
      `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_run_id UUID`,
      `UPDATE runs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, retry_after = 0,
           last_stop = CASE WHEN status = 'running' THEN '{"kind":"shutdown"}' ELSE last_stop END
         WHERE status IN ('pending', 'running') AND absurd_task_id IS NULL`,
      `DROP INDEX IF EXISTS idx_runs_pending_priority`,
      `DROP INDEX IF EXISTS idx_runs_session_active_created`,
      `CREATE INDEX IF NOT EXISTS idx_runs_session_in_flight ON runs(session_id, created_at, seq) WHERE status IN ('queued', 'pending', 'running')`,
      `CREATE INDEX IF NOT EXISTS idx_runs_session_queued ON runs(session_id, claim_priority, created_at, seq) WHERE status = 'queued'`,
    ],
  },
  {
    id: "runs/store/0013-drop-lease-expiry",
    statements: [`SET LOCAL lock_timeout = '60s'`, `ALTER TABLE runs DROP COLUMN IF EXISTS lease_expires_at`],
  },
];

export function createPostgresRunStore(connectionString: string): PostgresRuntime {
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const { query: q, close: closePool } = createPgPool(connectionString, RUN_STORE_MIGRATIONS);

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
  const runs: RunRows = {
    async getByDedupKey(dedupKey) {
      const { rows } = await q(`SELECT * FROM runs WHERE idempotency_key = $1`, [dedupKey]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async noteTurnUserSeq(runId: string, seq: number): Promise<boolean> {
      const { rowCount } = await q("UPDATE runs SET turn_user_seq=$2 WHERE id=$1 AND turn_user_seq IS NULL", [
        runId,
        seq,
      ]);
      return rowCount > 0;
    },

    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean> {
      if (leaseToken !== null && !(await turnFenceHeld({ query: q }, runId, leaseToken, { lock: false }))) return false;
      const { rowCount } = await q(
        "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2 AND ($3::text IS NULL OR lease_token=$3)",
        [JSON.stringify(state), runId, leaseToken],
      );
      return rowCount > 0;
    },

    async latestForThreads(threadRefs, opts) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT latest.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM runs WHERE session_id = threads.id
           AND (NOT $2::boolean OR COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true')
           ORDER BY created_at DESC, seq DESC LIMIT 1
         ) latest`,
        [[...new Set(threadRefs)], Boolean(opts?.excludePrivateMessages)],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },
    async latestForThread(threadRef, opts) {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND (NOT $2::boolean OR COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true') ORDER BY created_at DESC, seq DESC LIMIT 1",
        [threadRef, Boolean(opts?.excludePrivateMessages)],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },
    async pendingReturns(limit = 100, afterId = "") {
      const { rows } = await q(
        `SELECT * FROM (
           SELECT * FROM runs WHERE status IN ('done','failed') AND returned_at IS NULL
           AND session_id LIKE 'agent:main:subagent:%' AND id > $2
           UNION
           SELECT child.* FROM runs wake JOIN runs child
           ON child.id = substring(wake.idempotency_key FROM length('subagent-return:') + 1)
           WHERE wake.status IN ('queued','pending') AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
           AND wake.idempotency_key LIKE 'subagent-return:%'
           AND child.status IN ('done','failed') AND child.session_id LIKE 'agent:main:subagent:%'
           AND child.id > $2
         ) pending WHERE retry_after <= $3 ORDER BY id LIMIT $1`,
        [limit, afterId, Date.now()],
      );
      return rows.map(rowToRun);
    },
    async terminalFinished(after, beforeMs, limit) {
      const { rows } = await q(
        `SELECT * FROM runs WHERE status IN ('done','failed') AND finished_at <= $1
           AND (finished_at > $2 OR (finished_at = $2 AND id > $3))
         ORDER BY finished_at, id LIMIT $4`,
        [beforeMs, after.finishedAt, after.id, limit],
      );
      return rows.map(rowToRun);
    },
    async markReturned(runId) {
      await q("UPDATE runs SET returned_at = $2 WHERE id = $1 AND status IN ('done','failed')", [runId, Date.now()]);
    },
    async deferReturn(runId, delayMs) {
      await q("UPDATE runs SET retry_after = $2 WHERE id = $1 AND status IN ('done','failed')", [
        runId,
        Date.now() + Math.max(0, delayMs),
      ]);
    },
    onTerminal(listener): void {
      terminalListeners.push(listener);
    },
    emitTerminal: settle,

    get: getRun,

    async activeForThread(sessionId: string): Promise<Run | null> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('queued','pending','running') ORDER BY (status = 'running') DESC, (status = 'queued') ASC, created_at ASC, seq ASC LIMIT 1",
        [sessionId],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async inFlightForThread(sessionId: string): Promise<Run[]> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('queued','pending','running') ORDER BY (status = 'running') DESC, (status = 'queued') ASC, created_at ASC, seq ASC",
        [sessionId],
      );
      return rows.map(rowToRun);
    },

    async editPendingText(runId: string, text: string, expectedText: string): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE runs SET request = (request::jsonb || jsonb_build_object('text', $2::text, 'displayText', $2::text))::text
         WHERE id = $1 AND status IN ('queued','pending') AND attempts = 0 AND turn_user_seq IS NULL
         AND COALESCE(request::jsonb ->> 'displayText', request::jsonb ->> 'text') = $3`,
        [runId, pgTextSafe(text), pgTextSafe(expectedText)],
      );
      return (rowCount ?? 0) > 0;
    },

    async steerQueued(queuedRunId, targetRunId, signal, signals) {
      await signals.hasDedupeKey(signal.dedupeKey!);
      const { rows } = await q(
        `WITH target AS (
           SELECT id FROM runs WHERE id=$2 AND status IN ('queued','pending','running') FOR UPDATE
         ), moved AS (
           DELETE FROM runs WHERE id=$1 AND id<>$2 AND status='queued'
           AND COALESCE(request::jsonb->>'displayText',request::jsonb->>'text') = $5::jsonb->'request'->>'text'
           AND EXISTS (SELECT 1 FROM target) RETURNING id
         ), sent AS (
           INSERT INTO run_signals(run_id,kind,text,payload,created_at,dedupe_key)
           SELECT $2,$3,$4,$5,$6,$7 FROM moved RETURNING id
         ) SELECT pg_notify('run_signals',$2) FROM sent`,
        [
          queuedRunId,
          targetRunId,
          signal.kind,
          signal.text === undefined ? null : pgTextSafe(signal.text),
          jsonbStringify(signal),
          Date.now(),
          signal.dedupeKey ?? null,
        ],
      );
      return rows.length > 0;
    },

    async activeSessionIds(): Promise<string[]> {
      const { rows } = await q("SELECT DISTINCT session_id FROM runs WHERE status IN ('queued','pending','running')");
      return rows.map((r) => r.session_id as string);
    },

    async list({ limit = 200, threadRef }: { limit?: number; threadRef?: string } = {}): Promise<Run[]> {
      const { rows } = threadRef
        ? await q(
            "SELECT * FROM runs WHERE session_id = $1 OR starts_with(session_id, $1 || ':task:') OR starts_with(session_id, $1 || ':status:') ORDER BY created_at DESC LIMIT $2",
            [threadRef, limit],
          )
        : await q("SELECT * FROM runs ORDER BY created_at DESC LIMIT $1", [limit]);
      return rows.map(rowToRun);
    },

    waitFor(runId, timeoutMs = 60_000): Promise<Run> {
      return new Promise<Run>((resolve, reject) => {
        let done = false;
        const finish = (r: Run): void => {
          if (done) return;
          done = true;
          clearInterval(poll);
          clearTimeout(timer);
          events.off(runId, onSettle);
          resolve(r);
        };
        function onSettle(r: Run): void {
          finish(r);
        }
        events.once(runId, onSettle);
        const poll = setInterval(() => {
          void getRun(runId)
            .then((r) => {
              if (r && isTerminal(r.status)) finish(r);
            })
            .catch((err: unknown) => {
              console.error(
                "%s",
                `[postgres-run-store] waitFor poll for run ${runId} failed transiently:`,
                errMessage(err),
              );
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

  return { runs, close: () => runs.close!() };
}
