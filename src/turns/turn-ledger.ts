import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction, type PgPool, type PoolClient } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import type { TurnResult } from "../types.ts";
import type { EnqueueInput, EnqueueResult, Run, RunPriority, RunStop } from "../runs/run-store.ts";
import { isUnstarted, PARKED, releasesDedupKey, withTraceCarrier } from "../runs/run-store.ts";
import { rowToRun } from "../runs/postgres-run-store.ts";
import {
  absurdTable,
  awaitEvent,
  cancelTask,
  claimTasks,
  cleanup as cleanupQueue,
  emitEvent,
  completeRun,
  extendClaim,
  holdsClaim,
  scheduleRun,
  spawnTask,
  TaskCancelled,
} from "./absurd.ts";
import { ABSURD_MIGRATION, ABSURD_RETENTION_DAYS, TURN_QUEUES, type TurnQueue } from "./absurd-schema.ts";
import { turnFenceHeld } from "./turn-fence.ts";

const TURN_TASK = "turn";
export const TURN_READY_CHANNEL = "qm_turn_ready";
export const TURN_YIELD_CHANNEL = "qm_turn_yield";
const TURN_CLAIM_TIMEOUT_SEC = 60;
export const TURN_EXTEND_INTERVAL_MS = 20_000;
const CANCEL_WRAP_UP_GRACE_SEC = 30;
const TURN_RETENTION_SEC = ABSURD_RETENTION_DAYS * 24 * 60 * 60;
const CLEANUP_BATCH = 1_000;
const TURN_MAX_DURATION_SEC = 24 * 60 * 60;

interface TurnTaskParams {
  turnId: string;
}

const TURN_LEDGER_MIGRATION = {
  id: "turns/0001-ledger",
  statements: [
    `CREATE TABLE IF NOT EXISTS session_turn_pointers(
      thread_ref TEXT PRIMARY KEY,
      active_turn_id TEXT,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS session_turn_pointers_active ON session_turn_pointers(updated_at) WHERE active_turn_id IS NOT NULL`,
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
const BACKGROUND_PRIORITY: RunPriority = 2;

type TurnClaim = { claimed: boolean; run: null } | { claimed: true; run: Run };

export interface TurnLedger {
  claim(queue: TurnQueue, token: string, workerId: string): Promise<TurnClaim>;
  admit(input: EnqueueInput & { priority: RunPriority; maxAttempts: number }): Promise<EnqueueResult>;
  extend(run: Run, token: string): Promise<ExtendOutcome>;
  handBack(
    run: Run,
    token: string,
    opts: { stop?: RunStop; delayMs?: number; countsAsError?: boolean; unstarted?: boolean },
  ): Promise<boolean>;
  finish(run: Run, token: string, outcome: TurnOutcome): Promise<boolean>;
  fenceHeld(turnId: string, token: string, client?: PoolClient): Promise<boolean>;
  withdraw(turnId: string, opts?: { unstartedOnly?: boolean }): Promise<boolean>;
  repairCandidates(limit?: number): Promise<RepairCandidate[]>;
  repair(candidate: RepairCandidate, result: TurnResult): Promise<Run | null>;
  release(candidate: RepairCandidate): Promise<void>;
  startStranded(limit?: number): Promise<number>;
  cleanup(): Promise<number>;
  mustYield(run: Run): Promise<boolean>;
  yieldTo(run: Run, token: string): Promise<"yielded" | "handed_back" | "lost">;
  close(): Promise<void>;
}

const QUEUE_BY_PRIORITY: Record<RunPriority, TurnQueue> = {
  0: "turns_people",
  1: "turns_delegated",
  2: "turns_background",
};

function resumeEvent(turnId: string, parkings: number): string {
  return `resume:${turnId}:${parkings}`;
}

function queueOf(run: Pick<Run, "absurdQueue">): TurnQueue {
  const queue = run.absurdQueue;
  if (!queue || !(TURN_QUEUES as readonly string[]).includes(queue)) throw new Error("turn has no Absurd queue");
  return queue as TurnQueue;
}

function repairReason(row: Record<string, unknown>): string {
  if (row.turn == null) return "turn row missing";
  if (row.status !== "pending" && row.status !== "running") return `turn is ${String(row.status)}`;
  if (row.absurd_task_id == null) return "turn has no Absurd task";
  return `Absurd task ${String(row.task_state ?? "missing")}`;
}

const POINTER_KEY = "thread_ref = $1";

interface LedgerContext {
  db: PgPool;
  tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  settle(id: string): Promise<Run | null>;
}

async function lockPointer(client: PoolClient, threadRef: string): Promise<string | null> {
  await client.query(
    `INSERT INTO session_turn_pointers(thread_ref, active_turn_id, updated_at)
     VALUES ($1, NULL, $2) ON CONFLICT (thread_ref) DO NOTHING`,
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
}

async function lockTurn(client: PoolClient, turnId: string): Promise<void> {
  await client.query("SELECT 1 FROM runs WHERE id = $1 FOR NO KEY UPDATE", [turnId]);
}

async function start(client: PoolClient, run: Run): Promise<void> {
  const queue = queueOf(run);
  const params: TurnTaskParams = { turnId: run.id };
  const spawned = await spawnTask(client, queue, TURN_TASK, params, {
    idempotencyKey: run.id,
    maxAttempts: null,
    maxDurationSec: TURN_MAX_DURATION_SEC,
  });
  await client.query(`UPDATE runs SET status = 'pending', absurd_task_id = $2 WHERE id = $1`, [run.id, spawned.taskId]);
  await point(client, run.sessionId, run.id);
  await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, JSON.stringify(queue)]);
}

async function advance(client: PoolClient, threadRef: string, ending: string): Promise<void> {
  const parked = await client.query(
    `SELECT * FROM runs WHERE session_id = $1 AND status = 'pending' AND id <> $2
       AND absurd_task_id IS NOT NULL AND (last_stop::jsonb)->>'kind' = 'parked'
     ORDER BY created_at ASC, seq ASC LIMIT 1 FOR UPDATE`,
    [threadRef, ending],
  );
  if (parked.rows[0]) {
    const run = rowToRun(parked.rows[0]);
    const queue = queueOf(run);
    await point(client, threadRef, run.id);
    await emitEvent(client, queue, resumeEvent(run.id, run.preemptions), { turnId: run.id });
    await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, JSON.stringify(queue)]);
    return;
  }
  const { rows } = await client.query(
    `SELECT * FROM runs WHERE session_id = $1 AND status = 'queued'
     ORDER BY claim_priority ASC, created_at ASC, seq ASC LIMIT 1 FOR UPDATE`,
    [threadRef],
  );
  if (rows[0]) await start(client, rowToRun(rows[0]));
  else await point(client, threadRef, null);
}

async function releaseClaim(
  client: PoolClient,
  run: Run,
  token: string,
  change: { stop: RunStop | null; parks: number; errors: number; unstarted: boolean },
): Promise<number | null> {
  const { rows } = await client.query(
    `UPDATE runs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, worker_id = NULL,
       last_stop = COALESCE($3, last_stop), preemptions = preemptions + $4, error_attempts = error_attempts + $5,
       attempts = attempts - $6,
       started_at = CASE WHEN $6 = 1 AND attempts = 1 THEN NULL ELSE started_at END
     WHERE id = $1 AND lease_token = $2 AND status = 'running' RETURNING preemptions`,
    [
      run.id,
      token,
      change.stop ? JSON.stringify(change.stop) : null,
      change.parks,
      change.errors,
      change.unstarted ? 1 : 0,
    ],
  );
  return rows[0] ? Number(rows[0].preemptions) : null;
}

async function requeue(client: PoolClient, queue: TurnQueue, absurdRunId: string, at: Date): Promise<void> {
  await scheduleRun(client, queue, absurdRunId, at);
  if (at.getTime() > Date.now()) return;
  await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, JSON.stringify(queue)]);
}

async function askToYield(client: PoolClient, activeId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT * FROM runs WHERE id = $1 AND claim_priority = $2 AND status IN ('pending','running')
     FOR UPDATE`,
    [activeId, BACKGROUND_PRIORITY],
  );
  if (!rows[0]) return false;
  if (rows[0].status === "running") {
    await client.query("SELECT pg_notify($1, $2)", [TURN_YIELD_CHANNEL, JSON.stringify(activeId)]);
    return false;
  }
  await client.query("UPDATE runs SET last_stop = $2, preemptions = preemptions + 1 WHERE id = $1", [
    activeId,
    JSON.stringify(PARKED),
  ]);
  return true;
}

async function begin(
  ctx: LedgerContext,
  queue: TurnQueue,
  absurdRunId: string,
  turnId: string,
  token: string,
  workerId: string,
): Promise<Run | "suspended" | null> {
  const found = await ctx.db.query("SELECT session_id FROM runs WHERE id = $1", [turnId]);
  const threadRef = found.rows[0]?.session_id as string | undefined;
  if (!threadRef) return null;
  return ctx.tx(async (client) => {
    const active = await lockPointer(client, threadRef);
    const { rows: current } = await client.query("SELECT * FROM runs WHERE id = $1 FOR NO KEY UPDATE", [turnId]);
    if (!(await holdsClaim(client, queue, absurdRunId, token))) return null;
    const run = current[0] ? rowToRun(current[0]) : null;
    if (run && active !== turnId && run.status === "pending" && run.lastStop?.kind === "parked") {
      await awaitEvent(
        client,
        queue,
        run.absurdTaskId!,
        absurdRunId,
        `park:${run.preemptions}`,
        resumeEvent(run.id, run.preemptions),
      );
      return "suspended";
    }
    const { rows } = await client.query(
      `UPDATE runs SET status = 'running', lease_token = $2, lease_expires_at = NULL, worker_id = $3,
         attempts = attempts + 1, started_at = COALESCE(started_at, $4), absurd_run_id = $5,
         delivery_state = (delivery_state::jsonb - 'replying')::text
       WHERE id = $1 AND absurd_queue = $6 AND status IN ('pending','running')
       RETURNING *`,
      [turnId, token, workerId, Date.now(), absurdRunId, queue],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  });
}

async function cancelLocked(
  client: PoolClient,
  run: Run,
  active: string | null,
): Promise<{ outcome: "withdrawn" | "cancelled"; settled: boolean } | null> {
  if (run.status === "queued" && run.attempts === 0) {
    await client.query("DELETE FROM runs WHERE id = $1", [run.id]);
    if (active === run.id) await advance(client, run.sessionId, run.id);
    return { outcome: "withdrawn", settled: false };
  }
  if (run.status !== "queued" && run.status !== "pending") return null;
  if (run.absurdTaskId) await cancelTask(client, queueOf(run), run.absurdTaskId);
  let settled = false;
  if (run.attempts === 0) await client.query("DELETE FROM runs WHERE id = $1", [run.id]);
  else {
    await terminal(client, run, "done", { status: "ok", sessionId: run.sessionId, stopped: true }, 0);
    settled = true;
  }
  if (active === run.id) await advance(client, run.sessionId, run.id);
  return { outcome: "cancelled", settled };
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

function admission(ctx: LedgerContext): Pick<TurnLedger, "admit" | "claim" | "mustYield"> {
  const { db, tx } = ctx;
  return {
    async admit({ sessionId, request, dedupKey, maxAttempts, priority }) {
      return tx(async (client) => {
        const active = await lockPointer(client, sessionId);
        let inserted: Record<string, unknown> | undefined;
        while (!inserted) {
          if (dedupKey) {
            const { rows } = await client.query("SELECT * FROM runs WHERE idempotency_key = $1", [dedupKey]);
            if (rows[0]) return { run: rowToRun(rows[0]), deduped: true };
          }
          const { rows } = await client.query(
            `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at,
               claim_priority, absurd_queue)
             VALUES ($1, $2, 'queued', $3, $4, 0, $5, $6, $7, $8)
             ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
            [
              randomUUID(),
              sessionId,
              jsonbStringify(withTraceCarrier(request)),
              dedupKey ?? null,
              maxAttempts,
              Date.now(),
              priority,
              QUEUE_BY_PRIORITY[priority],
            ],
          );
          inserted = rows[0];
        }
        const queued = rowToRun(inserted);
        if (active && !(priority === 0 && (await askToYield(client, active)))) return { run: queued, deduped: false };
        if (active) {
          await start(client, queued);
          return { run: { ...queued, status: "pending" }, deduped: false };
        }
        await advance(client, sessionId, "");
        const { rows } = await client.query("SELECT * FROM runs WHERE id = $1", [queued.id]);
        return { run: rowToRun(rows[0]!), deduped: false };
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
      const run = await begin(ctx, queue, claimed.runId, params.turnId, token, workerId);
      if (run === "suspended") return { claimed: true, run: null };
      if (!run) {
        await completeRun(await db.pool(), queue, claimed.runId, { ok: false, reason: "turn not runnable" }).catch(
          (error: unknown) => {
            if (!(error instanceof TaskCancelled)) throw error;
          },
        );
        return { claimed: true, run: null };
      }
      await db.query(
        `DELETE FROM session_leases WHERE holder = 'turn'
           AND session_id IN (SELECT id FROM sessions WHERE thread_ref = $1)`,
        [run.sessionId],
      );
      return { claimed: true as const, run };
    },

    async mustYield(run) {
      const { rows } = await db.query(
        "SELECT 1 FROM runs WHERE session_id = $1 AND status = 'queued' AND claim_priority = 0 LIMIT 1",
        [run.sessionId],
      );
      return rows.length > 0;
    },
  };
}

function claims(ctx: LedgerContext): Pick<TurnLedger, "extend" | "handBack" | "finish" | "fenceHeld" | "yieldTo"> {
  const { tx, settle } = ctx;
  return {
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
        const released = await releaseClaim(client, run, token, {
          stop: stop ?? null,
          parks: stop?.kind === "parked" ? 1 : 0,
          errors: countsAsError ? 1 : 0,
          unstarted,
        });
        if (released === null) return false;
        await requeue(client, queue, run.absurdRunId!, new Date(wakeAt));
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
        if (active === run.id) await advance(client, run.sessionId, run.id);
        if (state.rows[0]?.state === "running") await completeRun(client, queue, run.absurdRunId!, { ok: true });
        return true;
      });
      if (applied) await settle(run.id);
      return applied;
    },

    fenceHeld: async (turnId, token, client) =>
      client ? turnFenceHeld(client, turnId, token) : turnFenceHeld(ctx.db, turnId, token, { lock: false }),

    async yieldTo(run, token) {
      const queue = queueOf(run);
      return tx(async (client) => {
        const active = await lockPointer(client, run.sessionId);
        await lockTurn(client, run.id);
        if (!(await holdsClaim(client, queue, run.absurdRunId!, token))) return "lost";
        const next = await client.query(
          `SELECT * FROM runs WHERE session_id = $1 AND status = 'queued' AND claim_priority = 0
           ORDER BY created_at ASC, seq ASC LIMIT 1 FOR UPDATE`,
          [run.sessionId],
        );
        const parkings = await releaseClaim(client, run, token, {
          stop: PARKED,
          parks: 1,
          errors: 0,
          unstarted: false,
        });
        if (parkings === null) return "lost";
        if (active !== run.id || !next.rows[0]) {
          await requeue(client, queue, run.absurdRunId!, new Date());
          return "handed_back";
        }
        await awaitEvent(
          client,
          queue,
          run.absurdTaskId!,
          run.absurdRunId!,
          `park:${parkings}`,
          resumeEvent(run.id, parkings),
        );
        await start(client, rowToRun(next.rows[0]));
        return "yielded";
      });
    },
  };
}

function cancellation(ctx: LedgerContext): Pick<TurnLedger, "withdraw"> {
  const { db, tx, settle } = ctx;
  return {
    async withdraw(turnId, opts) {
      const found = await db.query("SELECT session_id FROM runs WHERE id = $1", [turnId]);
      const threadRef = found.rows[0]?.session_id as string | undefined;
      if (!threadRef) return false;
      const done = await tx(async (client) => {
        const active = await lockPointer(client, threadRef);
        const { rows } = await client.query("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [turnId]);
        const run = rows[0] ? rowToRun(rows[0]) : null;
        if (!run || (opts?.unstartedOnly && !isUnstarted(run))) return null;
        return cancelLocked(client, run, active);
      });
      if (done?.settled) await settle(turnId);
      return done !== null;
    },
  };
}

function upkeep(
  ctx: LedgerContext,
): Pick<TurnLedger, "repairCandidates" | "repair" | "cleanup" | "release" | "startStranded"> {
  const { db, tx, settle } = ctx;
  return {
    async startStranded(limit = 100) {
      await db.query(
        `UPDATE runs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, worker_id = NULL,
           absurd_queue = CASE claim_priority WHEN 0 THEN 'turns_people' WHEN 1 THEN 'turns_delegated' ELSE 'turns_background' END,
           last_stop = CASE WHEN status = 'running' THEN '{"kind":"lease_expired"}' ELSE last_stop END
         WHERE absurd_task_id IS NULL AND absurd_run_id IS NULL
           AND (status = 'pending' OR (status = 'running' AND lease_expires_at < $1))`,
        [Date.now()],
      );
      const { rows } = await db.query(
        `SELECT DISTINCT r.session_id FROM runs r
          LEFT JOIN session_turn_pointers p ON p.thread_ref = r.session_id
          WHERE r.status = 'queued' AND p.active_turn_id IS NULL
          LIMIT $1`,
        [limit],
      );
      let started = 0;
      for (const row of rows) {
        const threadRef = String(row.session_id);
        await tx(async (client) => {
          if ((await lockPointer(client, threadRef)) !== null) return;
          await advance(client, threadRef, "");
          started += 1;
        });
      }
      return started;
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
          WHERE p.active_turn_id IS NOT NULL
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
        await advance(client, threadRef, turnId);
      });
    },
  };
}

export function createTurnLedger(connectionString: string, opts: { onTerminal?: (run: Run) => void } = {}): TurnLedger {
  const db: PgPool = createPgPool(connectionString, [ABSURD_MIGRATION, TURN_LEDGER_MIGRATION]);
  const ctx: LedgerContext = {
    db,
    tx: async (fn) => withPgTransaction(await db.pool(), fn),
    async settle(id) {
      const { rows } = await db.query("SELECT * FROM runs WHERE id = $1", [id]);
      const run = rows[0] ? rowToRun(rows[0]) : null;
      if (run) opts.onTerminal?.(run);
      return run;
    },
  };
  return {
    ...admission(ctx),
    ...claims(ctx),
    ...cancellation(ctx),
    ...upkeep(ctx),
    close: () => db.close(),
  };
}
