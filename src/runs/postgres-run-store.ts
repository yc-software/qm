import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createPgPool } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import { pgTextSafe } from "../util/text.ts";
import { isObj } from "../util/objects.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { EnqueueInput, EnqueueResult, ReapEvent, Run, RunDeliveryState, RunStore } from "./run-store.ts";
import { isTerminal, releasesDedupKey } from "./run-store.ts";
import { errMessage, swallow } from "../util/errors.ts";
import type { LedgerBegin, ToolLedger } from "./tool-ledger.ts";

export interface PostgresRuntime {
  runs: RunStore;
  ledger: ToolLedger;
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
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  };
}

const FENCE_HOLD_MS = 600_000;

export function createPostgresRunStore(connectionString: string, opts?: { maxClaims?: number }): PostgresRuntime {
  const available = createPostgresNotifyBus<null>(connectionString, "qm_run_available", "run availability");
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY;
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const { query: q, close: closePool } = createPgPool(
    connectionString,
    [
      {
        id: "runs/store/0001",
        expectedChecksum: "07a121d0fa4e8ae4049e0574939dbf938c8615dc39ce29b74805a7e8ccb4ad0f",
        statements: [
          `CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
        request TEXT NOT NULL, result TEXT, idempotency_key TEXT UNIQUE,
        attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
        lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT,
        created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT
      )`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery_state TEXT`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_attempts INT NOT NULL DEFAULT 0`,
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
        ],
      },
      {
        id: "runs/store/0002",
        expectedChecksum: "c0fc23238fbe0ace56a28278bcb6cadfb100eb2c24ee83ce873588d466930270",
        statements: [
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
          `CREATE INDEX IF NOT EXISTS idx_runs_status_created_seq ON runs(status, created_at, seq)`,
        ],
      },
      {
        id: "runs/store/0003",
        expectedChecksum: "8594c46c02ee90d43292a4c083fedea6c72d93b5f414f75e9e20d2db51b1b595",
        statements: [`SET LOCAL lock_timeout = '3s'`, `ALTER TABLE runs ADD COLUMN IF NOT EXISTS turn_user_seq BIGINT`],
      },
      {
        id: "runs/store/0004",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS retry_after BIGINT NOT NULL DEFAULT 0`,
        ],
      },
      {
        id: "runs/store/0004-subagent-returns",
        statements: [
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS returned_at BIGINT`,
          `CREATE INDEX IF NOT EXISTS idx_runs_pending_child_returns ON runs(id) WHERE status IN ('done','failed') AND returned_at IS NULL AND session_id LIKE 'agent:main:subagent:%'`,
        ],
      },
      {
        id: "runs/store/0005-session-history",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_session_created_seq ON runs(session_id, created_at DESC, seq DESC)`,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_created ON runs(created_at DESC)`,
        ],
      },
    ],
    [
      {
        id: "runs/maintenance/tool-calls-key",
        beforeMigrations: true,
        statements: [
          `DO $$
      BEGIN
        IF to_regclass('tool_calls') IS NOT NULL THEN
          ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;
          IF EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'tool_calls'::regclass AND c.contype = 'p'
              AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                  ) <> ARRAY['run_id','attempt','call_index']
          ) OR NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'tool_calls'::regclass AND c.contype = 'p'
          ) THEN
            DELETE FROM tool_calls t USING (
              SELECT ctid, row_number() OVER (
                PARTITION BY run_id, attempt, call_index ORDER BY created_at DESC, ctid DESC
              ) AS rn FROM tool_calls
            ) dup WHERE t.ctid = dup.ctid AND dup.rn > 1;
            ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_pkey;
            ALTER TABLE tool_calls ADD PRIMARY KEY (run_id, attempt, call_index);
          END IF;
        END IF;
      END $$`,
        ],
      },
    ],
  );

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
    opts?: { ifExpiredAt?: number; countsAsError?: boolean; retryAfterMs?: number },
  ): Promise<{ requeued: boolean; applied: boolean }> {
    const ifExpiredAt = opts?.ifExpiredAt ?? null;
    const countsAsError = opts?.countsAsError ?? false;
    const errorAttemptsAfter = run.errorAttempts + (countsAsError ? 1 : 0);
    const overClaimed = run.attempts >= maxClaims;
    if (retry && errorAttemptsAfter < run.maxAttempts && !overClaimed) {
      const { rowCount } = await q(
        `UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL,
           error_attempts=error_attempts+$4, retry_after=$5
         WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3) RETURNING pg_notify('qm_run_available', 'null')`,
        [run.id, run.leaseToken, ifExpiredAt, countsAsError ? 1 : 0, Date.now() + Math.max(0, opts?.retryAfterMs ?? 0)],
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
       WHERE id=$1 AND lease_token=$2 AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3) RETURNING pg_notify('qm_run_available', 'null')`,
      [run.id, run.leaseToken, ifExpiredAt, JSON.stringify(result), Date.now(), countsAsError ? 1 : 0],
    );
    if (rowCount > 0) settle(await getRun(run.id));
    return { requeued: false, applied: rowCount > 0 };
  }

  async function claim(workerId: string, ttlMs: number, runId?: string, sessionId?: string): Promise<Run | null> {
    const token = randomUUID();
    const now = Date.now();
    try {
      const { rows } = await q(
        `UPDATE runs SET status='running', lease_token=$1, lease_expires_at=$2, worker_id=$3,
           attempts=attempts+1, started_at=COALESCE(started_at,$4)
         WHERE id = (
           SELECT candidate.id FROM runs candidate WHERE candidate.status='pending'
             AND candidate.retry_after <= $4
             AND ($5::text IS NULL OR candidate.id=$5)
             AND ($6::text IS NULL OR candidate.session_id=$6)
             AND NOT EXISTS (
               SELECT 1 FROM runs sibling WHERE sibling.session_id=candidate.session_id
                 AND (sibling.status='running' OR (sibling.status='pending'
                   AND (sibling.retry_after > $4 OR (sibling.created_at, sibling.seq) < (candidate.created_at, candidate.seq))))
             )
           ORDER BY candidate.created_at ASC, candidate.seq ASC FOR UPDATE SKIP LOCKED LIMIT 1
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
      for (;;) {
        const { rows } = await q(
          `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at)
           VALUES ($1,$2,'pending',$3,$4,0,$5,$6)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *, pg_notify('qm_run_available', 'null')`,
          [id, sessionId, jsonbStringify(request), dedupKey ?? null, maxAttempts, Date.now()],
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

    async heartbeat(runId, leaseToken, ttlMs): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET lease_expires_at=$1 WHERE id=$2 AND lease_token=$3 AND status='running'",
        [Date.now() + ttlMs, runId, leaseToken],
      );
      return rowCount > 0;
    },

    async releaseLease(runId, leaseToken): Promise<boolean> {
      const { rowCount } = await q(
        "UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING pg_notify('qm_run_available', 'null')",
        [runId, leaseToken],
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
          await retire(run, error, opts?.retry !== false, { countsAsError: true, retryAfterMs: opts?.retryAfterMs })
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
          ? await q("UPDATE runs SET delivery_state=$1 WHERE id=$2", [JSON.stringify(state), runId])
          : await q("UPDATE runs SET delivery_state=$1 WHERE id=$2 AND lease_token=$3", [
              JSON.stringify(state),
              runId,
              leaseToken,
            ]);
      return rowCount > 0;
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
