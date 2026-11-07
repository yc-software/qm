import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { createHash, randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import { isObj } from "../util/objects.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import type {
  EnqueueInput,
  EnqueueResult,
  ReapEvent,
  Run,
  RunDeliveryState,
  RunStop,
  RunStore,
  SessionWatch,
} from "./run-store.ts";
import type { RunPriority } from "./run-store.ts";
import {
  countedClaims,
  isTerminal,
  RUN_WAIT_FALLBACK_MS,
  runPriority,
  stopErrorCode,
  withTraceCarrier,
} from "./run-store.ts";
import { swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

const NOTIFY_SESSION_AVAILABLE =
  "pg_notify('qm_run_available', to_json(encode(sha256(convert_to(session_id, 'UTF8')), 'hex'))::text)";

function sessionAvailabilityKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

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
    request,
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
  const available = createPostgresNotifyBus<string>(connectionString, "qm_run_available", "run availability");
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY;

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
  function watchSession(sessionId: string): SessionWatch {
    let changed = true;
    let wake: (() => void) | undefined;
    const note = (): void => {
      changed = true;
      wake?.();
    };
    const key = sessionAvailabilityKey(sessionId);
    const off = available.subscribe((session) => session === key && note(), { onResync: note });
    return {
      changed(timeoutMs, signal) {
        return new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            wake = undefined;
            changed = false;
            resolve();
          };
          const timer = setTimeout(done, changed || signal?.aborted ? 0 : timeoutMs);
          signal?.addEventListener("abort", done);
          wake = done;
        });
      },
      close: off,
    };
  }
  const terminalListeners: Array<(run: Run) => void> = [];
  function settle(run: Run | null): void {
    if (!run || !isTerminal(run.status)) return;
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
         WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3) RETURNING ${NOTIFY_SESSION_AVAILABLE}`,
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
       WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3) RETURNING ${NOTIFY_SESSION_AVAILABLE}`,
      [run.id, run.leaseToken, ifExpiredAt, JSON.stringify(result), Date.now(), countsAsError ? 1 : 0],
    );
    if (rowCount > 0) settle(await getRun(run.id));
    return { requeued: false, applied: rowCount > 0 };
  }

  const parked = (run: string) => `(${run}.claim_priority > 0 AND ${run}.last_stop::jsonb->>'kind' = 'parked')`;

  const turnOrder = (run: string) => `(CASE WHEN ${run}.claim_priority <> 0 THEN 1
      WHEN EXISTS (
        SELECT 1 FROM runs ahead WHERE ahead.session_id=${run}.session_id AND ahead.status='pending'
          AND ahead.claim_priority > 0 AND ${parked("ahead")} IS NOT TRUE
          AND (ahead.created_at, ahead.seq) < (${run}.created_at, ${run}.seq)
      ) THEN 1 ELSE 0 END), ${run}.created_at, ${run}.seq`;

  const before = (a: string, b: string) => `(CASE
      WHEN ${parked(a)} IS NOT TRUE AND ${parked(b)} IS NOT TRUE
        THEN (${a}.created_at, ${a}.seq) < (${b}.created_at, ${b}.seq)
      ELSE (${turnOrder(a)}) < (${turnOrder(b)}) END)`;

  const claimable = (
    now: string,
    behindRunning = false,
  ) => `candidate.status='pending' AND candidate.retry_after <= ${now}
    AND NOT EXISTS (
      SELECT 1 FROM runs sibling WHERE sibling.session_id=candidate.session_id
        AND (${behindRunning ? "false" : "sibling.status='running'"} OR (sibling.status='pending'
          AND (sibling.retry_after > ${now} OR ${before("sibling", "candidate")})))
      OFFSET 0
    )`;

  async function claim(
    workerId: string,
    ttlMs: number,
    target: { limit?: number; runId?: string } = {},
  ): Promise<Run[]> {
    const now = Date.now();
    try {
      const { rows } = await q(
        `WITH picked AS (
           SELECT candidate.id FROM runs candidate WHERE ${claimable("$3")}
             AND ($4::text IS NULL OR candidate.id=$4)
           ORDER BY candidate.claim_priority ASC, candidate.created_at ASC, candidate.seq ASC FOR UPDATE SKIP LOCKED LIMIT $5
         )
         UPDATE runs SET status='running', lease_token=gen_random_uuid()::text, lease_expires_at=$1, worker_id=$2,
           attempts=attempts+1, started_at=COALESCE(started_at,$3)
         FROM picked WHERE runs.id = picked.id RETURNING runs.*`,
        [now + ttlMs, workerId, now, target.runId ?? null, target.limit ?? 1],
      );
      return rows.map(rowToRun);
    } catch (err) {
      if (isUniqueViolation(err)) return [];
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
    watchSession,
    ...(Number.isFinite(maxClaims) ? { maxClaims } : {}),

    async enqueue({
      id: requestedId,
      sessionId,
      request,
      dedupKey,
      maxAttempts = 3,
    }: EnqueueInput): Promise<EnqueueResult> {
      const id = requestedId ?? randomUUID();
      const delegating = request.delegatingRunId ? await getRun(request.delegatingRunId) : null;
      const priority = runPriority(request, delegating?.priority ?? null);
      for (;;) {
        const { rows } = await q(
          `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at, claim_priority)
           VALUES ($1,$2,'pending',$3,$4,0,$5,$6,$7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *, ${NOTIFY_SESSION_AVAILABLE}`,
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

    claim: (workerId, ttlMs, limit) => claim(workerId, ttlMs, { limit }),
    claimById: async (runId, workerId, ttlMs) => (await claim(workerId, ttlMs, { runId }))[0] ?? null,
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
    async personWaitingIn(sessionIds, createdBefore) {
      const { rows } = await q(
        `SELECT DISTINCT candidate.session_id FROM runs candidate WHERE candidate.session_id = ANY($1::text[])
           AND candidate.claim_priority=0 AND candidate.created_at <= $2 AND ${claimable("$3", true)}`,
        [sessionIds, createdBefore, Date.now()],
      );
      return new Set(rows.map((row) => row.session_id as string));
    },

    async heartbeat(runId, leaseToken, ttlMs): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET lease_expires_at=$1 WHERE id=$2 AND lease_token=$3 AND status='running'",
        [Date.now() + ttlMs, runId, leaseToken],
      );
      return rowCount > 0;
    },

    async releaseLease(runId, leaseToken, stop, retryAfter = 0): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL, last_stop=COALESCE($3, last_stop), preemptions=preemptions+$4, retry_after=GREATEST(retry_after, $5) WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING ${NOTIFY_SESSION_AVAILABLE}`,
        [runId, leaseToken, stop ? JSON.stringify(stop) : null, stop?.kind === "parked" ? 1 : 0, retryAfter],
      );
      return rowCount > 0;
    },

    async complete(runId, leaseToken, result): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE runs SET status='done', result=$1, lease_token=NULL, lease_expires_at=NULL, finished_at=$2
         WHERE id=$3 AND lease_token=$4 RETURNING ${NOTIFY_SESSION_AVAILABLE}`,
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

    async activeForThreads(threadRefs) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT current.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM runs WHERE session_id = threads.id AND status IN ('pending', 'running')
           ORDER BY status = 'running' DESC, ${turnOrder("runs")} LIMIT 1
         ) current`,
        [[...new Set(threadRefs)]],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },
    async pendingReturns(limit = 100, afterId = "", threadRefs) {
      const text = `SELECT * FROM (
           SELECT * FROM runs WHERE status IN ('done','failed') AND returned_at IS NULL
           AND session_id LIKE 'agent:main:subagent:%' AND id > $2
           UNION
           SELECT child.* FROM runs wake JOIN runs child
           ON child.id = substring(wake.idempotency_key FROM length('subagent-return:') + 1)
           WHERE wake.status = 'pending' AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
           AND wake.idempotency_key LIKE 'subagent-return:%'
           AND child.status IN ('done','failed') AND child.session_id LIKE 'agent:main:subagent:%'
           AND child.id > $2
         ) pending WHERE ${threadRefs ? "session_id = ANY($3)" : "retry_after <= $3"} ORDER BY id LIMIT $1`;
      const params = [limit, afterId, threadRefs ?? Date.now()];
      const { rows } = await q(text, params);
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

    async lastFinishedForThreads(threadRefs) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT last.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM runs WHERE session_id = threads.id AND status IN ('done', 'failed')
           ORDER BY created_at DESC, seq DESC LIMIT 1
         ) last`,
        [[...new Set(threadRefs)]],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },

    async activeForThread(sessionId: string): Promise<Run | null> {
      return (await runs.activeForThreads([sessionId])).get(sessionId) ?? null;
    },

    async inFlightForThread(sessionId: string): Promise<Run[]> {
      const { rows } = await q(
        `SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY (status = 'running') DESC, ${turnOrder("runs")}`,
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
        `DELETE FROM runs WHERE id = $1 AND status = 'pending' AND (NOT $2::boolean OR (attempts = 0 AND turn_user_seq IS NULL)) RETURNING ${NOTIFY_SESSION_AVAILABLE}`,
        [runId, Boolean(opts?.unstartedOnly)],
      );
      return (rowCount ?? 0) > 0;
    },

    async steerQueued(queuedRunId, targetRunId, signal, signals) {
      await signals.runForDedupeKey(signal.dedupeKey!);
      const { rows } = await q(
        `WITH target AS (
           SELECT id FROM runs WHERE id=$2 AND status IN ('pending','running') FOR UPDATE
         ), moved AS (
           DELETE FROM runs WHERE id=$1 AND id<>$2 AND status='pending'
           AND COALESCE(request::jsonb->>'displayText',request::jsonb->>'text') = $5::jsonb->'request'->>'text'
           AND EXISTS (SELECT 1 FROM target) RETURNING id, ${NOTIFY_SESSION_AVAILABLE}
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
            "SELECT * FROM runs WHERE session_id = $1 OR starts_with(session_id, $1 || ':task:') OR starts_with(session_id, $1 || ':status:') ORDER BY created_at DESC, seq DESC LIMIT $2",
            [threadRef, limit],
          )
        : await q("SELECT * FROM runs ORDER BY created_at DESC, seq DESC LIMIT $1", [limit]);
      return rows.map(rowToRun);
    },

    async reapExpired(opts?: {
      maxAgeMs?: number;
      onReap?: (event: ReapEvent) => void;
    }): Promise<{ requeued: number; parked: number }> {
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

    async waitFor(runId, timeoutMs = 60_000): Promise<Run> {
      const deadline = Date.now() + timeoutMs;
      let watch: SessionWatch | undefined;
      try {
        for (;;) {
          const run = await getRun(runId);
          if (run && isTerminal(run.status)) return run;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
          if (run) watch ??= watchSession(run.sessionId);
          const wait = Math.min(RUN_WAIT_FALLBACK_MS, remaining);
          await (watch ? watch.changed(wait) : sleep(wait));
        }
      } finally {
        watch?.close();
      }
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
