import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createPgPool } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import { isObj } from "../util/objects.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { EnqueueInput, EnqueueResult, ReapEvent, Run, RunDeliveryState, RunStop, RunStore } from "./run-store.ts";
import type { RunPriority } from "./run-store.ts";
import {
  countedClaims,
  isTerminal,
  releasesDedupKey,
  runPriority,
  stopErrorCode,
  withTraceCarrier,
} from "./run-store.ts";
import { errMessage, swallow } from "../util/errors.ts";

export interface PostgresRuntime {
  runs: RunStore;
  close(): Promise<void>;
}

function isUniqueViolation(err: unknown): boolean {
  return isObj(err) && err.code === "23505";
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
    turnUserSeq: r.turn_user_seq != null ? Number(r.turn_user_seq) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    priority: Number(r.claim_priority) as RunPriority,
    preemptions: Number(r.preemptions),
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    lastStop: r.last_stop != null ? (JSON.parse(r.last_stop as string) as RunStop) : null,
  };
}

const FENCE_HOLD_MS = 600_000;
const PREVIOUS_SCHEMA = "runs/store/0010-drop-turn-metrics";

export function createPostgresRunStore(connectionString: string, opts?: { maxClaims?: number }): PostgresRuntime {
  const available = createPostgresNotifyBus<null>(connectionString, "qm_run_available", "run availability");
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY;
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const { query: q, close: closePool } = createPgPool(connectionString, [
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
  ]);

  const availabilityListeners = new Map<() => void, number>();
  let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let availabilityProbe: Promise<void> | null = null;
  let availabilityClosed = false;

  function watchAvailability(): void {
    if (availabilityClosed || availabilityListeners.size === 0 || availabilityTimer || availabilityProbe) return;
    availabilityTimer = setTimeout(
      () => {
        availabilityTimer = undefined;
        availabilityProbe = q(
          `SELECT EXISTS (
          SELECT 1 FROM runs r WHERE r.status='pending' AND r.retry_after <= $1
          AND NOT EXISTS (
            SELECT 1 FROM runs blocked WHERE blocked.session_id=r.session_id
              AND (blocked.status='running' OR (blocked.status='pending' AND blocked.retry_after > $1))
          )
        ) AS available`,
          [Date.now()],
        )
          .then(({ rows }) => {
            if (rows[0]?.available) for (const listener of availabilityListeners.keys()) listener();
          })
          .catch((error: unknown) => swallow("run availability probe", error))
          .finally(() => {
            availabilityProbe = null;
            watchAvailability();
          });
      },
      Math.min(...availabilityListeners.values()),
    );
    availabilityTimer.unref();
  }

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
    opts?: { ifExpiredAt?: number; countsAsError?: boolean; retryAfterMs?: number; stop?: RunStop },
  ): Promise<{ requeued: boolean; applied: boolean }> {
    const ifExpiredAt = opts?.ifExpiredAt ?? null;
    const countsAsError = opts?.countsAsError ?? false;
    const errorAttemptsAfter = run.errorAttempts + (countsAsError ? 1 : 0);
    const overClaimed = countedClaims(run) >= maxClaims;
    if (retry && errorAttemptsAfter < run.maxAttempts && !overClaimed) {
      const { rowCount } = await q(
        `UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL,
           error_attempts=error_attempts+$4, retry_after=$5, last_stop=$6
         WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3) RETURNING pg_notify('qm_run_available', 'null')`,
        [
          run.id,
          run.leaseToken,
          ifExpiredAt,
          countsAsError ? 1 : 0,
          Date.now() + Math.max(0, opts?.retryAfterMs ?? 0),
          JSON.stringify(opts?.stop ?? (countsAsError ? { kind: "error" } : { kind: "lease_expired" })),
        ],
      );
      return { requeued: rowCount > 0, applied: rowCount > 0 };
    }
    const reason =
      !countsAsError && overClaimed && retry && errorAttemptsAfter < run.maxAttempts
        ? `run parked after ${countedClaims(run)} claims without completing (suspected crash loop)`
        : error;
    const result: TurnResult = { status: "failed", sessionId: run.sessionId, reason, ...stopErrorCode(opts?.stop) };
    const { rowCount } = await q(
      `UPDATE runs SET status='failed', result=$4, lease_token=NULL, lease_expires_at=NULL, worker_id=NULL, finished_at=$5,
         error_attempts=error_attempts+$6
       WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3) RETURNING pg_notify('qm_run_available', 'null')`,
      [run.id, run.leaseToken, ifExpiredAt, JSON.stringify(result), Date.now(), countsAsError ? 1 : 0],
    );
    if (rowCount > 0) settle(await getRun(run.id));
    return { requeued: false, applied: rowCount > 0 };
  }

  const claimable = (now: string) => `candidate.status='pending' AND candidate.retry_after <= ${now}
    AND NOT EXISTS (
      SELECT 1 FROM runs sibling WHERE sibling.session_id=candidate.session_id
        AND (sibling.status='running' OR (sibling.status='pending'
          AND (sibling.retry_after > ${now} OR (sibling.created_at, sibling.seq) < (candidate.created_at, candidate.seq))))
      OFFSET 0
    )`;

  async function claim(workerId: string, ttlMs: number, runId?: string, sessionId?: string): Promise<Run | null> {
    const token = randomUUID();
    const now = Date.now();
    try {
      const { rows } = await q(
        `UPDATE runs SET status='running', lease_token=$1, lease_expires_at=$2, worker_id=$3,
           attempts=attempts+1, started_at=COALESCE(started_at,$4)
         WHERE id = (
           SELECT candidate.id FROM runs candidate WHERE ${claimable("$4")}
             AND ($5::text IS NULL OR candidate.id=$5)
             AND ($6::text IS NULL OR candidate.session_id=$6)
           ORDER BY candidate.claim_priority ASC, candidate.created_at ASC, candidate.seq ASC FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING *`,
        [token, now + ttlMs, workerId, now, runId ?? null, sessionId ?? null],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  const runs: RunStore = {
    subscribeAvailable(listener, options) {
      availabilityListeners.set(listener, options?.pollMs ?? 50);
      clearTimeout(availabilityTimer);
      availabilityTimer = undefined;
      const off = available.subscribe(listener, options);
      watchAvailability();
      return () => {
        off();
        availabilityListeners.delete(listener);
        if (availabilityListeners.size === 0) {
          clearTimeout(availabilityTimer);
          availabilityTimer = undefined;
        }
      };
    },
    ...(Number.isFinite(maxClaims) ? { maxClaims } : {}),

    async enqueue({ sessionId, request, dedupKey, maxAttempts = 3 }: EnqueueInput): Promise<EnqueueResult> {
      const id = randomUUID();
      const delegating = request.delegatingRunId ? await getRun(request.delegatingRunId) : null;
      const priority = runPriority(request, delegating?.priority ?? null);
      for (;;) {
        const { rows } = await q(
          `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at, claim_priority)
           VALUES ($1,$2,'pending',$3,$4,0,$5,$6,$7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *, pg_notify('qm_run_available', 'null')`,
          [
            id,
            sessionId,
            jsonbStringify(withTraceCarrier(request)),
            dedupKey ?? null,
            maxAttempts,
            Date.now(),
            priority,
          ],
        );
        if (rows[0]) return { run: rowToRun(rows[0]), deduped: false };
        const existing = await runs.getByDedupKey(dedupKey!);
        if (existing) return { run: existing, deduped: true };
      }
    },

    async getByDedupKey(dedupKey) {
      const { rows } = await q(`SELECT * FROM runs WHERE idempotency_key = $1`, [dedupKey]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    claim,

    claimById: (runId, workerId, ttlMs) => claim(workerId, ttlMs, runId),
    claimForSession: (sessionId, workerId, ttlMs) => claim(workerId, ttlMs, undefined, sessionId),
    async personWaiting(createdBefore) {
      const { rows } = await q(
        `SELECT EXISTS (
           SELECT 1 FROM runs candidate WHERE ${claimable("$2")}
             AND candidate.claim_priority=0 AND candidate.created_at <= $1
         ) AS waiting`,
        [createdBefore, Date.now()],
      );
      return rows[0]?.waiting === true;
    },

    async heartbeat(runId, leaseToken, ttlMs): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET lease_expires_at=$1 WHERE id=$2 AND lease_token=$3 AND status='running'",
        [Date.now() + ttlMs, runId, leaseToken],
      );
      return rowCount > 0;
    },

    async releaseLease(runId, leaseToken, stop): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL, last_stop=COALESCE($3, last_stop), preemptions=preemptions+$4 WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING pg_notify('qm_run_available', 'null')",
        [runId, leaseToken, stop ? JSON.stringify(stop) : null, stop?.kind === "parked" ? 1 : 0],
      );
      return rowCount > 0;
    },

    async complete(runId, leaseToken, result): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE runs SET status='done', result=$1, lease_token=NULL, lease_expires_at=NULL, finished_at=$2,
           idempotency_key = CASE WHEN $5 THEN NULL ELSE idempotency_key END
         WHERE id=$3 AND lease_token=$4 RETURNING pg_notify('qm_run_available', 'null')`,
        [JSON.stringify(result), Date.now(), runId, leaseToken, releasesDedupKey(result)],
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
      return {
        requeued: (
          await retire(run, error, opts?.retry !== false, {
            countsAsError: true,
            retryAfterMs: opts?.retryAfterMs,
            ...(opts?.stop ? { stop: opts.stop } : {}),
          })
        ).requeued,
      };
    },

    async noteTurnUserSeq(runId: string, seq: number): Promise<boolean> {
      const { rowCount } = await q("UPDATE runs SET turn_user_seq=$2 WHERE id=$1 AND turn_user_seq IS NULL", [
        runId,
        seq,
      ]);
      return rowCount > 0;
    },

    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean> {
      const { rowCount } =
        leaseToken === null
          ? await q(
              "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2",
              [JSON.stringify(state), runId],
            )
          : await q(
              "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2 AND lease_token=$3",
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
           WHERE wake.status = 'pending' AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
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

    get: getRun,

    async activeForThread(sessionId: string): Promise<Run | null> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY (status = 'running') DESC, created_at ASC, seq ASC LIMIT 1",
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

    async editPendingText(runId: string, text: string, expectedText: string): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE runs SET request = (request::jsonb || jsonb_build_object('text', $2::text, 'displayText', $2::text))::text
         WHERE id = $1 AND status = 'pending' AND attempts = 0 AND turn_user_seq IS NULL
         AND COALESCE(request::jsonb ->> 'displayText', request::jsonb ->> 'text') = $3`,
        [runId, pgTextSafe(text), pgTextSafe(expectedText)],
      );
      return (rowCount ?? 0) > 0;
    },

    async withdraw(runId: string, opts): Promise<boolean> {
      const { rowCount } = await q(
        "DELETE FROM runs WHERE id = $1 AND status = 'pending' AND (NOT $2::boolean OR (attempts = 0 AND turn_user_seq IS NULL))",
        [runId, Boolean(opts?.unstartedOnly)],
      );
      return (rowCount ?? 0) > 0;
    },

    async steerQueued(queuedRunId, targetRunId, signal, signals) {
      await signals.hasDedupeKey(signal.dedupeKey!);
      const { rows } = await q(
        `WITH target AS (
           SELECT id FROM runs WHERE id=$2 AND status IN ('pending','running') FOR UPDATE
         ), moved AS (
           DELETE FROM runs WHERE id=$1 AND id<>$2 AND status='pending'
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
      const { rows } = await q("SELECT DISTINCT session_id FROM runs WHERE status IN ('pending','running')");
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
      for (const run of expired) {
        const tooOld = opts?.maxAgeMs !== undefined && run.startedAt !== null && now - run.startedAt > opts.maxAgeMs;
        const reason = tooOld ? "run exceeded max age (reaped)" : "lease expired (reaped)";
        const fenceToken = randomUUID();
        const fenced = await q(
          "UPDATE runs SET lease_token=$1, lease_expires_at=$5 WHERE id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at <= $4 RETURNING id",
          [fenceToken, run.id, run.leaseToken, now, now + FENCE_HOLD_MS],
        );
        if (!fenced.rows[0]) continue;
        if (onRetired) await onRetired([run.sessionId]);
        const r = await retire({ ...run, leaseToken: fenceToken }, reason, !tooOld);
        if (!r.applied) continue;
        if (r.requeued) requeued++;
        else parked++;
        opts?.onReap?.({
          runId: run.id,
          sessionId: run.sessionId,
          workerId: run.workerId,
          attempts: run.attempts,
          errorAttempts: run.errorAttempts,
          outcome: r.requeued ? "requeued" : "parked",
        });
      }
      return { requeued, parked };
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
      availabilityClosed = true;
      clearTimeout(availabilityTimer);
      availabilityListeners.clear();
      await availabilityProbe;
      await available.close?.();
      await closePool();
    },
  };

  return { runs, close: () => runs.close!() };
}
