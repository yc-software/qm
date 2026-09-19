import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { PoolClient } from "pg";
import {
  ABSURD_CHECKPOINT_FENCING_MIGRATION,
  ABSURD_MIGRATION,
  ABSURD_HANDOFF_MIGRATION,
  ABSURD_WORKER_FENCING_MIGRATION,
  ABSURD_WORKER_CLAIM_HANDOFF_MIGRATION,
  ABSURD_EXPIRED_HANDOFF_MIGRATION,
  DURABLE_RETRY_STRATEGY,
} from "../durable/schema.ts";
import { SESSION_LEASE_OWNERSHIP_MIGRATION } from "../sessions/lease-ownership.ts";
import { RUN_HANDOFF_WORKFLOW_MIGRATION, RUN_WORKFLOW_MIGRATION } from "./postgres-run-workflows.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { EnqueueInput, EnqueueResult, Run, RunDeliveryState, RunStore } from "./run-store.ts";
import { claimsSpent, isTerminal } from "./run-store.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { getOperationSignal } from "../util/async.ts";
import type { LedgerBegin, ToolLedger } from "./tool-ledger.ts";

export interface PostgresRuntime {
  runs: RunStore;
  ledger: ToolLedger;
  close(): Promise<void>;
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
    handoffs: Number(r.handoffs ?? 0),
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

export function createPostgresRunStore(
  connectionString: string,
  opts?: { maxClaims?: number; maxAgeMs?: number },
): PostgresRuntime {
  const available = createPostgresNotifyBus<null>(connectionString, "qm_run_available", "run availability");
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY;
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const pg = createPgPool(
    connectionString,
    [
      ABSURD_MIGRATION,
      ABSURD_HANDOFF_MIGRATION,
      ABSURD_CHECKPOINT_FENCING_MIGRATION,
      ABSURD_WORKER_FENCING_MIGRATION,
      ABSURD_WORKER_CLAIM_HANDOFF_MIGRATION,
      ABSURD_EXPIRED_HANDOFF_MIGRATION,
      SESSION_LEASE_OWNERSHIP_MIGRATION,
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
      RUN_WORKFLOW_MIGRATION,
      {
        id: "runs/store/0006-handoffs",
        statements: ["ALTER TABLE runs ADD COLUMN IF NOT EXISTS handoffs INT NOT NULL DEFAULT 0"],
      },
      RUN_HANDOFF_WORKFLOW_MIGRATION,
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

  const { query: q, close: closePool } = pg;

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
          `SELECT EXISTS (SELECT 1 FROM absurd.r_qm_runs WHERE state IN ('pending','sleeping') AND available_at <= absurd.current_time()) AS available`,
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
  async function lockedRun(client: PoolClient, id: string, token: string): Promise<Run | null> {
    const owner = await client.query(
      `SELECT execution.run_id FROM absurd.r_qm_runs execution
       WHERE execution.run_id::text=$2 AND execution.task_id=(SELECT workflow_task_id FROM runs WHERE id=$1)
       AND execution.state='running' AND execution.claim_expires_at > absurd.current_time() FOR UPDATE`,
      [id, token],
    );
    if (!owner.rows[0]) return null;
    const { rows } = await client.query(
      "SELECT * FROM runs WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",
      [id, token],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async function terminal(client: PoolClient, run: Run, result: TurnResult, status: "done" | "failed"): Promise<void> {
    await client.query("SELECT absurd.complete_run('qm_runs',$1,$2)", [
      run.leaseToken,
      JSON.stringify({ status, result }),
    ]);
  }

  async function claim(workerId: string, ttlMs: number, runId?: string, sessionId?: string): Promise<Run | null> {
    const specific = runId !== undefined || sessionId !== undefined;
    const count = specific ? 256 : 1;
    for (let round = 0; round < 32; round++) {
      const signal = getOperationSignal();
      signal?.throwIfAborted();
      const { rows: claimed } = await q(
        "SELECT * FROM qm_claim_tasks('qm_runs',$1,$2,$3)",
        [workerId, Math.max(1, Math.ceil(ttlMs / 1000)), count],
        { signal },
      );
      signal?.throwIfAborted();
      if (!claimed.length) return null;
      let selected: Run | null = null;
      for (const task of claimed) {
        const next = await withPgTransaction(await pg.pool(), async (client) => {
          const execution = await client.query(
            "SELECT run_id,claim_expires_at FROM absurd.r_qm_runs WHERE run_id=$1 AND state='running' FOR UPDATE",
            [task.run_id],
          );
          if (!execution.rows[0]) return {};
          const { rows } = await client.query("SELECT * FROM runs WHERE workflow_task_id=$1 FOR UPDATE SKIP LOCKED", [
            task.task_id,
          ]);
          const row = rows[0];
          if (!row && (await client.query("SELECT 1 FROM runs WHERE workflow_task_id=$1", [task.task_id])).rows[0]) {
            await client.query("SELECT absurd.schedule_run('qm_runs',$1,absurd.current_time())", [task.run_id]);
            return {};
          }
          if (!row || isTerminal(row.status)) {
            await client.query("SELECT absurd.cancel_task('qm_runs',$1)", [task.task_id]);
            return {};
          }
          if (
            selected ||
            (runId !== undefined && row.id !== runId) ||
            (sessionId !== undefined && row.session_id !== sessionId)
          ) {
            await client.query("SELECT absurd.schedule_run('qm_runs',$1,absurd.current_time())", [task.run_id]);
            return {};
          }
          const previous = await client.query(
            `SELECT id FROM runs WHERE session_id=$1 AND status IN ('pending','running') AND id<>$2
             AND (status='running' OR (created_at,seq)<($3,$4)) ORDER BY created_at DESC,seq DESC LIMIT 1`,
            [row.session_id, row.id, row.created_at, row.seq],
          );
          if (previous.rows[0]) return { event: `run-terminal:${previous.rows[0].id}` };
          const { rows: started } = await client.query(
            `UPDATE runs SET status='running',lease_token=$2,lease_expires_at=$3,worker_id=$4,
              attempts=workflow_attempt_base+$5+handoffs,started_at=COALESCE(started_at,$6) WHERE id=$1 RETURNING *`,
            [
              row.id,
              task.run_id,
              new Date(execution.rows[0].claim_expires_at).getTime(),
              workerId,
              task.attempt,
              Date.now(),
            ],
          );
          return { run: rowToRun(started[0]!) };
        });
        if (next.run) selected = next.run;
        else if (next.event) {
          try {
            const waiting = await q("SELECT * FROM absurd.await_event('qm_runs',$1,$2,$3,$3,NULL)", [
              task.task_id,
              task.run_id,
              next.event,
            ]);
            if (waiting.rows[0]?.should_suspend === false)
              await q("SELECT absurd.schedule_run('qm_runs',$1,absurd.current_time())", [task.run_id]);
          } catch (error) {
            if (!(error instanceof Object && "code" in error && (error.code === "AB001" || error.code === "AB002")))
              throw error;
          }
        }
      }
      if (selected || specific) return selected;
    }
    return null;
  }

  const runs: RunStore = {
    backgroundOnly: true,
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
      return withPgTransaction(await pg.pool(), async (client) => {
        const id = randomUUID();
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`run-admission:${sessionId}`]);
        let inserted: Record<string, unknown>;
        for (;;) {
          const { rows } = await client.query(
            `INSERT INTO runs(id,session_id,status,request,idempotency_key,attempts,max_attempts,created_at)
             VALUES($1,$2,'pending',$3,$4,0,$5,$6) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
            [id, sessionId, JSON.stringify(request), dedupKey ?? null, maxAttempts, Date.now()],
          );
          if (rows[0]) {
            inserted = rows[0];
            break;
          }
          const prior = await client.query("SELECT * FROM runs WHERE idempotency_key=$1", [dedupKey]);
          if (prior.rows[0]) return { run: rowToRun(prior.rows[0]), deduped: true };
        }
        const spawned = await client.query("SELECT * FROM absurd.spawn_task('qm_runs','run.execute',$1,$2)", [
          JSON.stringify({ runId: id }),
          JSON.stringify({
            idempotency_key: `run:${id}`,
            max_attempts: Number.isFinite(maxClaims) ? maxClaims : null,
            retry_strategy: { kind: "exponential", base_seconds: 15, factor: 2, max_seconds: 60 },
            cancellation: { max_duration: Math.max(1, Math.ceil((opts?.maxAgeMs ?? 24 * 60 * 60_000) / 1000)) },
          }),
        ]);
        await client.query("UPDATE runs SET workflow_task_id=$2 WHERE id=$1", [id, spawned.rows[0]!.task_id]);
        await client.query("SELECT pg_notify('qm_run_available','null')");
        return { run: rowToRun(inserted), deduped: false };
      });
    },

    async getByDedupKey(dedupKey) {
      const { rows } = await q(`SELECT * FROM runs WHERE idempotency_key = $1`, [dedupKey]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    claim,

    claimById: (runId, workerId, ttlMs) => claim(workerId, ttlMs, runId),
    claimForSession: (sessionId, workerId, ttlMs) => claim(workerId, ttlMs, undefined, sessionId),

    async handoffWorker(workerId, keepLeaseTokens = []) {
      await q("SELECT qm_handoff_worker('qm_runs',$1,$2::uuid[])", [workerId, keepLeaseTokens]);
    },

    async heartbeat(runId, leaseToken, ttlMs): Promise<boolean> {
      return withPgTransaction(await pg.pool(), async (client) => {
        if (!(await lockedRun(client, runId, leaseToken))) return false;
        await client.query("SELECT absurd.extend_claim('qm_runs',$1,$2)", [
          leaseToken,
          Math.max(1, Math.ceil(ttlMs / 1000)),
        ]);
        await client.query(
          "UPDATE runs SET lease_expires_at=(SELECT (extract(epoch FROM claim_expires_at)*1000)::bigint FROM absurd.r_qm_runs WHERE run_id=$2::uuid) WHERE id=$1",
          [runId, leaseToken],
        );
        return true;
      });
    },

    async releaseLease(runId, leaseToken, opts): Promise<boolean> {
      return withPgTransaction(await pg.pool(), async (client) => {
        const run = await lockedRun(client, runId, leaseToken);
        if (!run) return false;
        if (opts?.handoff) {
          const { rows } = await client.query("SELECT qm_handoff_run('qm_runs',$1,$2) AS successor", [
            leaseToken,
            run.workerId,
          ]);
          if (!rows[0]?.successor) return false;
          return true;
        }
        await client.query("SELECT absurd.fail_run('qm_runs',$1,$2,absurd.current_time())", [
          leaseToken,
          JSON.stringify({ name: "DeploymentDrain", message: "deployment handed back execution" }),
        ]);
        return true;
      });
    },

    async complete(runId, leaseToken, result): Promise<boolean> {
      const completed = await withPgTransaction(await pg.pool(), async (client) => {
        const run = await lockedRun(client, runId, leaseToken);
        if (!run) return false;
        await terminal(client, run, result, "done");
        return true;
      });
      if (completed) settle(await getRun(runId));
      return completed;
    },

    async fail(runId, leaseToken, error, opts): Promise<{ requeued: boolean }> {
      const requeued = await withPgTransaction(await pg.pool(), async (client) => {
        const run = await lockedRun(client, runId, leaseToken);
        if (!run) return false;
        await client.query("UPDATE runs SET error_attempts=error_attempts+1 WHERE id=$1", [runId]);
        if (opts?.retry === false || run.errorAttempts + 1 >= run.maxAttempts || claimsSpent(run) >= maxClaims) {
          await terminal(client, run, { status: "failed", sessionId: run.sessionId, reason: error }, "failed");
          return false;
        }
        await client.query("SELECT absurd.fail_run('qm_runs',$1,$2,$3)", [
          leaseToken,
          JSON.stringify({ name: "TurnFailure", message: error }),
          opts?.retryAfterMs !== undefined ? new Date(Date.now() + Math.max(0, opts.retryAfterMs)) : null,
        ]);
        return true;
      });
      if (!requeued) settle(await getRun(runId));
      return { requeued };
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
        `SELECT * FROM runs WHERE status IN ('done','failed') AND returned_at IS NULL
         AND session_id LIKE 'agent:main:subagent:%'
         AND id > $2 ORDER BY id LIMIT $1`,
        [limit, afterId],
      );
      return rows.map(rowToRun);
    },
    async markReturned(runId) {
      await q("UPDATE runs SET returned_at = $2 WHERE id = $1 AND status IN ('done','failed')", [runId, Date.now()]);
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
        [runId, text, expectedText],
      );
      return (rowCount ?? 0) > 0;
    },

    async withdraw(runId: string): Promise<boolean> {
      return withPgTransaction(await pg.pool(), async (client) => {
        await client.query(
          "SELECT run_id FROM absurd.r_qm_runs WHERE task_id=(SELECT workflow_task_id FROM runs WHERE id=$1) AND state NOT IN ('completed','failed','cancelled') ORDER BY run_id FOR UPDATE",
          [runId],
        );
        const { rows } = await client.query(
          "DELETE FROM runs WHERE id=$1 AND status='pending' RETURNING workflow_task_id",
          [runId],
        );
        if (!rows[0]) return false;
        if (rows[0].workflow_task_id)
          await client.query("SELECT absurd.cancel_task('qm_runs',$1)", [rows[0].workflow_task_id]);
        await client.query("SELECT absurd.emit_event('qm_runs',$1,'null'::jsonb)", [`run-terminal:${runId}`]);
        await client.query("SELECT absurd.emit_event('qm_handoffs',$1,'null'::jsonb)", [`run-terminal:${runId}`]);
        return true;
      });
    },

    async steerQueued(queuedRunId, targetRunId, signal, signals) {
      await signals.hasDedupeKey(signal.dedupeKey!);
      return withPgTransaction(await pg.pool(), async (client) => {
        const target = await client.query(
          "SELECT id FROM runs WHERE id=$1 AND status IN ('pending','running') FOR UPDATE",
          [targetRunId],
        );
        if (!target.rows[0]) return false;
        await client.query(
          "SELECT run_id FROM absurd.r_qm_runs WHERE task_id=(SELECT workflow_task_id FROM runs WHERE id=$1) AND state NOT IN ('completed','failed','cancelled') ORDER BY run_id FOR UPDATE",
          [queuedRunId],
        );
        const { rows } = await client.query(
          `DELETE FROM runs WHERE id=$1 AND id<>$2 AND status='pending'
             AND COALESCE(request::jsonb->>'displayText',request::jsonb->>'text')=$3
             RETURNING workflow_task_id`,
          [queuedRunId, targetRunId, signal.request?.text],
        );
        if (!rows[0]) return false;
        if (rows[0].workflow_task_id)
          await client.query("SELECT absurd.cancel_task('qm_runs',$1)", [rows[0].workflow_task_id]);
        await client.query("SELECT absurd.emit_event('qm_runs',$1,'null'::jsonb)", [`run-terminal:${queuedRunId}`]);
        await client.query("SELECT absurd.emit_event('qm_handoffs',$1,'null'::jsonb)", [`run-terminal:${queuedRunId}`]);
        const sent = await client.query(
          `INSERT INTO run_signals(run_id,kind,text,payload,created_at,dedupe_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [targetRunId, signal.kind, signal.text ?? null, JSON.stringify(signal), Date.now(), signal.dedupeKey ?? null],
        );
        await client.query("SELECT absurd.spawn_task('qm_handoffs','signal.replay',$1,$2)", [
          JSON.stringify({ runId: targetRunId }),
          JSON.stringify({ idempotency_key: `signal:${sent.rows[0]!.id}`, retry_strategy: DURABLE_RETRY_STRATEGY }),
        ]);
        await client.query("SELECT pg_notify('run_signals',$1)", [targetRunId]);
        return true;
      });
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

    async reapExpired(): Promise<{ requeued: number; parked: number }> {
      return { requeued: 0, parked: 0 };
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
