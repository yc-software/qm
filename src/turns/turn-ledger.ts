import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgPool, withPgTransaction, type PgPool, type PoolClient } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import type { TurnResult } from "../types.ts";
import type { EnqueueInput, EnqueueResult, Run, RunPriority, RunStop } from "../runs/run-store.ts";
import { releasesDedupKey, withTraceCarrier } from "../runs/run-store.ts";
import { rowToRun } from "../runs/postgres-run-store.ts";
import {
  cancelTask,
  claimTasks,
  cleanup as cleanupQueue,
  completeRun,
  extendClaim,
  holdsClaim,
  scheduleRun,
  spawnTask,
  TaskCancelled,
} from "./absurd.ts";
import { TURN_QUEUES, type TurnQueue } from "./absurd-schema.ts";
import { turnFenceHeld } from "./turn-fence.ts";

const TURN_TASK = "turn";
export const TURN_READY_CHANNEL = "qm_turn_ready";
export const TURN_CANCEL_CHANNEL = "qm_turn_cancel";
const TURN_MAX_ATTEMPTS = 10;
const TURN_CLAIM_TIMEOUT_SEC = 60;
export const TURN_EXTEND_INTERVAL_MS = 20_000;
const CANCEL_WRAP_UP_GRACE_SEC = 30;
const TURN_RETENTION_SEC = 7 * 24 * 60 * 60;
const CLEANUP_BATCH = 1_000;

interface TurnTaskParams {
  tenantId: string;
  turnId: string;
}

const TURN_LEDGER_MIGRATION = {
  id: "turns/0001-ledger",
  statements: [
    `CREATE TABLE IF NOT EXISTS session_turn_pointers(
      tenant_id UUID NOT NULL DEFAULT qm_tenant_id(),
      thread_ref TEXT NOT NULL,
      active_turn_id TEXT,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(tenant_id, thread_ref)
    )`,
    `CREATE INDEX IF NOT EXISTS session_turn_pointers_active ON session_turn_pointers(tenant_id, updated_at) WHERE active_turn_id IS NOT NULL`,
    `CREATE OR REPLACE FUNCTION qm_turn_fence(p_turn text, p_token text) RETURNS boolean LANGUAGE plpgsql AS $qm_turn_fence$
     DECLARE
       v_queue text;
       v_run uuid;
       v_ok boolean;
     BEGIN
       SELECT absurd_queue, absurd_run_id INTO v_queue, v_run FROM runs
        WHERE id = p_turn AND engine = 'absurd' AND status = 'running' AND lease_token = p_token
        FOR SHARE;
       IF v_queue IS NULL OR v_run IS NULL THEN
         RETURN false;
       END IF;
       EXECUTE format(
         'SELECT true FROM absurd.%I WHERE run_id = $1 AND ((state = ''running'' AND claimed_by = $2) OR state = ''cancelled'') FOR SHARE',
         'r_' || v_queue)
         INTO v_ok USING v_run, p_token;
       RETURN COALESCE(v_ok, false);
     END $qm_turn_fence$`,
  ],
};

export type TurnOutcome =
  { status: "done"; result: TurnResult } | { status: "failed"; result: TurnResult; countsAsError?: boolean };

type ExtendOutcome = "held" | "lost" | "cancelled";

interface RepairCandidate {
  threadRef: string;
  turnId: string;
  reason: string;
}

const UNKNOWN_TASK_DEFER_MS = 30_000;

export interface TurnLedger {
  claim(queue: TurnQueue, token: string, workerId: string): Promise<{ claimed: boolean; run: Run | null }>;
  admit(input: EnqueueInput & { priority: RunPriority }): Promise<EnqueueResult | null>;
  begin(queue: TurnQueue, runId: string, turnId: string, token: string, workerId: string): Promise<Run | null>;
  extend(run: Run, token: string): Promise<ExtendOutcome>;
  handBack(
    run: Run,
    token: string,
    opts: { stop?: RunStop; delayMs?: number; countsAsError?: boolean; unstarted?: boolean },
  ): Promise<boolean>;
  finish(run: Run, token: string, outcome: TurnOutcome): Promise<boolean>;
  fenceHeld(turnId: string, token: string, client?: PoolClient): Promise<boolean>;
  cancel(turnId: string): Promise<"withdrawn" | "cancelled" | "signalled" | null>;
  repairCandidates(limit?: number): Promise<RepairCandidate[]>;
  repair(candidate: RepairCandidate, result: TurnResult): Promise<Run | null>;
  release(candidate: RepairCandidate): Promise<void>;
  cleanup(): Promise<number>;
  close(): Promise<void>;
}

function turnQueueFor(_priority: RunPriority): TurnQueue {
  return "turns_people";
}

function queueOf(run: Pick<Run, "absurdQueue">): TurnQueue {
  const queue = run.absurdQueue;
  if (!queue || !(TURN_QUEUES as readonly string[]).includes(queue)) throw new Error("turn has no Absurd queue");
  return queue as TurnQueue;
}

function absurdTable(queue: TurnQueue, prefix: "r_" | "t_"): string {
  return `absurd.${pg.escapeIdentifier(prefix + queue)}`;
}

function repairReason(row: Record<string, unknown>): string {
  if (row.turn == null) return "turn row missing";
  if (row.status !== "pending" && row.status !== "running") return `turn is ${String(row.status)}`;
  if (row.absurd_task_id == null) return "turn has no Absurd task";
  return `Absurd task ${String(row.task_state ?? "missing")}`;
}

const POINTER_KEY = "tenant_id = qm_tenant_id() AND thread_ref = $1";

export function createTurnLedger(connectionString: string, opts: { onTerminal?: (run: Run) => void } = {}): TurnLedger {
  const db: PgPool = createPgPool(connectionString, [TURN_LEDGER_MIGRATION]);
  let tenant: Promise<string> | null = null;
  const tenantId = (client: PoolClient): Promise<string> =>
    (tenant ??= client
      .query("SELECT qm_tenant_id()::text AS id")
      .then(({ rows }) => String(rows[0]!.id))
      .catch((error: unknown) => {
        tenant = null;
        throw error;
      }));
  const tx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => withPgTransaction(await db.pool(), fn);

  async function lockPointer(client: PoolClient, threadRef: string): Promise<string | null> {
    await client.query(
      `INSERT INTO session_turn_pointers(tenant_id, thread_ref, active_turn_id, updated_at)
       VALUES (qm_tenant_id(), $1, NULL, $2) ON CONFLICT (tenant_id, thread_ref) DO NOTHING`,
      [threadRef, Date.now()],
    );
    const { rows } = await client.query(
      `SELECT active_turn_id FROM session_turn_pointers WHERE ${POINTER_KEY} FOR UPDATE`,
      [threadRef],
    );
    return (rows[0]?.active_turn_id as string | null | undefined) ?? null;
  }

  async function point(client: PoolClient, threadRef: string, turnId: string | null): Promise<void> {
    await client.query(`UPDATE session_turn_pointers SET active_turn_id = $2, updated_at = $3 WHERE ${POINTER_KEY}`, [
      threadRef,
      turnId,
      Date.now(),
    ]);
    if (turnId === null) await client.query("SELECT pg_notify('qm_run_available', 'null')");
  }

  async function lockTurn(client: PoolClient, turnId: string): Promise<void> {
    await client.query("SELECT 1 FROM runs WHERE id = $1 FOR NO KEY UPDATE", [turnId]);
  }

  async function start(client: PoolClient, run: Run): Promise<void> {
    const queue = queueOf(run);
    const params: TurnTaskParams = { tenantId: await tenantId(client), turnId: run.id };
    const spawned = await spawnTask(client, queue, TURN_TASK, params, {
      idempotencyKey: run.id,
      maxAttempts: TURN_MAX_ATTEMPTS,
    });
    await client.query(`UPDATE runs SET status = 'pending', absurd_task_id = $2 WHERE id = $1`, [
      run.id,
      spawned.taskId,
    ]);
    await point(client, run.sessionId, run.id);
    await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, JSON.stringify(queue)]);
  }

  async function advance(client: PoolClient, threadRef: string): Promise<void> {
    const { rows } = await client.query(
      `SELECT * FROM runs WHERE session_id = $1 AND status = 'queued'
       ORDER BY claim_priority ASC, created_at ASC, seq ASC LIMIT 1 FOR UPDATE`,
      [threadRef],
    );
    if (rows[0]) await start(client, rowToRun(rows[0]));
    else await point(client, threadRef, null);
  }

  async function settle(id: string): Promise<Run | null> {
    const { rows } = await db.query("SELECT * FROM runs WHERE id = $1", [id]);
    const run = rows[0] ? rowToRun(rows[0]) : null;
    if (run) opts.onTerminal?.(run);
    return run;
  }

  async function terminal(
    client: PoolClient,
    run: Run,
    status: "done" | "failed",
    result: TurnResult,
    errorIncrement: number,
  ): Promise<void> {
    await client.query(
      `UPDATE runs SET status = $2, result = $3, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL,
         finished_at = $4, error_attempts = error_attempts + $5,
         idempotency_key = CASE WHEN $6 THEN NULL ELSE idempotency_key END
       WHERE id = $1`,
      [run.id, status, JSON.stringify(result), Date.now(), errorIncrement, releasesDedupKey(result)],
    );
  }

  return {
    async admit({ sessionId, request, dedupKey, maxAttempts = 3, priority }) {
      return tx(async (client) => {
        const active = await lockPointer(client, sessionId);
        if (dedupKey) {
          const { rows } = await client.query("SELECT * FROM runs WHERE idempotency_key = $1", [dedupKey]);
          if (rows[0]) return { run: rowToRun(rows[0]), deduped: true };
        }
        const legacy = await client.query(
          `SELECT 1 FROM runs WHERE session_id = $1 AND engine = 'legacy' AND status IN ('pending','running') LIMIT 1`,
          [sessionId],
        );
        if (legacy.rows[0]) return null;
        const { rows } = await client.query(
          `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at,
             claim_priority, engine, absurd_queue)
           VALUES ($1, $2, 'queued', $3, $4, 0, $5, $6, $7, 'absurd', $8)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            sessionId,
            jsonbStringify(withTraceCarrier(request)),
            dedupKey ?? null,
            maxAttempts,
            Date.now(),
            priority,
            turnQueueFor(priority),
          ],
        );
        if (!rows[0]) {
          const existing = await client.query("SELECT * FROM runs WHERE idempotency_key = $1", [dedupKey]);
          return { run: rowToRun(existing.rows[0]!), deduped: true };
        }
        const queued = rowToRun(rows[0]);
        if (active) return { run: queued, deduped: false };
        await start(client, queued);
        return { run: { ...queued, status: "pending" }, deduped: false };
      });
    },

    async claim(queue, token, workerId) {
      const [claimed] = await claimTasks(await db.pool(), queue, token, TURN_CLAIM_TIMEOUT_SEC, 1);
      if (!claimed) return { claimed: false, run: null };
      const params = claimed.params as Partial<TurnTaskParams> | null;
      if (claimed.taskName !== TURN_TASK || typeof params?.turnId !== "string") {
        await scheduleRun(await db.pool(), queue, claimed.runId, new Date(Date.now() + UNKNOWN_TASK_DEFER_MS));
        return { claimed: true, run: null };
      }
      const run = await this.begin(queue, claimed.runId, params.turnId, token, workerId);
      if (!run) {
        await completeRun(await db.pool(), queue, claimed.runId, { ok: false, reason: "turn not runnable" });
        return { claimed: true, run };
      }
      await db.query(
        `DELETE FROM session_leases WHERE holder = 'turn'
           AND session_id IN (SELECT id FROM sessions WHERE thread_ref = $1)`,
        [run.sessionId],
      );
      return { claimed: true, run };
    },

    async begin(queue, runId, turnId, token, workerId) {
      return tx(async (client) => {
        await lockTurn(client, turnId);
        if (!(await holdsClaim(client, queue, runId, token))) return null;
        const { rows } = await client.query(
          `UPDATE runs SET status = 'running', lease_token = $2, lease_expires_at = NULL, worker_id = $3,
             attempts = attempts + 1, started_at = COALESCE(started_at, $4), absurd_run_id = $5
           WHERE id = $1 AND engine = 'absurd' AND absurd_queue = $6 AND status IN ('pending','running')
           RETURNING *`,
          [turnId, token, workerId, Date.now(), runId, queue],
        );
        return rows[0] ? rowToRun(rows[0]) : null;
      });
    },

    async extend(run, token) {
      const queue = queueOf(run);
      try {
        return await tx(async (client) => {
          await lockTurn(client, run.id);
          if (!(await holdsClaim(client, queue, run.absurdRunId!, token))) {
            return (await turnFenceHeld(client, run.id, token)) ? "cancelled" : "lost";
          }
          await extendClaim(client, queue, run.absurdRunId!, TURN_CLAIM_TIMEOUT_SEC);
          return "held";
        });
      } catch (error) {
        if (error instanceof TaskCancelled) return "cancelled";
        throw error;
      }
    },

    async handBack(run, token, { stop, delayMs = 0, countsAsError = false, unstarted = false }) {
      const queue = queueOf(run);
      const wakeAt = Date.now() + Math.max(0, delayMs);
      return tx(async (client) => {
        await lockTurn(client, run.id);
        if (!(await holdsClaim(client, queue, run.absurdRunId!, token))) return false;
        const { rowCount } = await client.query(
          `UPDATE runs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, worker_id = NULL,
             last_stop = COALESCE($3, last_stop), preemptions = preemptions + $4, error_attempts = error_attempts + $5,
             attempts = attempts - $6,
             started_at = CASE WHEN $6 = 1 AND attempts = 1 THEN NULL ELSE started_at END
           WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
          [
            run.id,
            token,
            stop ? JSON.stringify(stop) : null,
            stop?.kind === "parked" ? 1 : 0,
            countsAsError ? 1 : 0,
            unstarted ? 1 : 0,
          ],
        );
        if (!rowCount) return false;
        await scheduleRun(client, queue, run.absurdRunId!, new Date(wakeAt));
        await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, JSON.stringify(queue)]);
        return true;
      });
    },

    async finish(run, token, outcome) {
      const queue = queueOf(run);
      const applied = await tx(async (client) => {
        const active = await lockPointer(client, run.sessionId);
        await lockTurn(client, run.id);
        if (!(await turnFenceHeld(client, run.id, token))) return false;
        const state = await client.query(`SELECT state FROM ${absurdTable(queue, "r_")} WHERE run_id = $1`, [
          run.absurdRunId,
        ]);
        const errorIncrement = outcome.status === "failed" && outcome.countsAsError ? 1 : 0;
        await terminal(client, run, outcome.status, outcome.result, errorIncrement);
        if (active === run.id) await advance(client, run.sessionId);
        if (state.rows[0]?.state === "running") await completeRun(client, queue, run.absurdRunId!, { ok: true });
        return true;
      });
      if (applied) await settle(run.id);
      return applied;
    },

    fenceHeld: async (turnId, token, client) => turnFenceHeld(client ?? db, turnId, token),

    async cancel(turnId) {
      const found = await db.query("SELECT session_id FROM runs WHERE id = $1 AND engine = 'absurd'", [turnId]);
      const threadRef = found.rows[0]?.session_id as string | undefined;
      if (!threadRef) return null;
      let settled = false;
      const outcome = await tx(async (client) => {
        const active = await lockPointer(client, threadRef);
        const { rows } = await client.query("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [turnId]);
        if (!rows[0]) return null;
        const run = rowToRun(rows[0]);
        if (run.status === "queued") {
          await client.query("DELETE FROM runs WHERE id = $1", [turnId]);
          return "withdrawn" as const;
        }
        if (run.status !== "pending" && run.status !== "running") return null;
        if (run.absurdTaskId) await cancelTask(client, queueOf(run), run.absurdTaskId);
        if (run.status === "running") {
          await client.query("SELECT pg_notify($1, $2)", [TURN_CANCEL_CHANNEL, JSON.stringify(turnId)]);
          return "signalled" as const;
        }
        if (run.attempts === 0) await client.query("DELETE FROM runs WHERE id = $1", [turnId]);
        else {
          await terminal(client, run, "done", { status: "ok", sessionId: run.sessionId, stopped: true }, 0);
          settled = true;
        }
        if (active === turnId) await advance(client, threadRef);
        return "cancelled" as const;
      });
      if (settled) await settle(turnId);
      return outcome;
    },

    async repairCandidates(limit = 100) {
      const joins = TURN_QUEUES.map(
        (queue, i) =>
          `LEFT JOIN ${absurdTable(queue, "t_")} k${i} ON t.absurd_queue = '${queue}' AND k${i}.task_id = t.absurd_task_id`,
      ).join("\n");
      const state = `COALESCE(${TURN_QUEUES.map((_, i) => `k${i}.state`).join(", ")})`;
      const cancelledAt = `COALESCE(${TURN_QUEUES.map((_, i) => `k${i}.cancelled_at`).join(", ")})`;
      const { rows } = await db.query(
        `SELECT p.thread_ref, p.active_turn_id, t.id AS turn, t.status, t.absurd_task_id, ${state} AS task_state
           FROM session_turn_pointers p
           LEFT JOIN runs t ON t.id = p.active_turn_id
           ${joins}
          WHERE p.tenant_id = qm_tenant_id() AND p.active_turn_id IS NOT NULL
            AND (t.id IS NULL OR t.status NOT IN ('pending','running') OR t.absurd_task_id IS NULL
              OR ${state} IS NULL OR ${state} IN ('failed','completed')
              OR (${state} = 'cancelled' AND ${cancelledAt} < absurd.current_time() - make_interval(secs => $2)))
          LIMIT $1`,
        [limit, CANCEL_WRAP_UP_GRACE_SEC],
      );
      return rows.map((row) => ({
        threadRef: String(row.thread_ref),
        turnId: String(row.active_turn_id),
        reason: repairReason(row),
      }));
    },

    async repair({ threadRef, turnId }, result) {
      const finished = await tx(async (client) => {
        if ((await lockPointer(client, threadRef)) !== turnId) return false;
        const { rows } = await client.query("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [turnId]);
        const run = rows[0] ? rowToRun(rows[0]) : null;
        if (!run || (run.status !== "pending" && run.status !== "running")) return false;
        await terminal(client, run, "failed", result, 0);
        return true;
      });
      return finished ? settle(turnId) : null;
    },

    async cleanup() {
      let removed = 0;
      for (const queue of TURN_QUEUES) {
        for (;;) {
          const { tasks } = await cleanupQueue(await db.pool(), queue, TURN_RETENTION_SEC, CLEANUP_BATCH);
          removed += tasks;
          if (tasks < CLEANUP_BATCH) break;
        }
      }
      return removed;
    },

    async release({ threadRef, turnId }) {
      await tx(async (client) => {
        if ((await lockPointer(client, threadRef)) !== turnId) return;
        const { rows } = await client.query("SELECT status FROM runs WHERE id = $1", [turnId]);
        if (rows[0]?.status === "pending" || rows[0]?.status === "running") return;
        await advance(client, threadRef);
      });
    },

    close: () => db.close(),
  };
}
