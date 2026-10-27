import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgPool, withPgTransaction, type PgPool, type PoolClient, tenantCols } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import type { TurnResult } from "../types.ts";
import type { EnqueueInput, EnqueueResult, Run, RunPriority, RunStop } from "../runs/run-store.ts";
import { isUnstarted, PARKED, releasesDedupKey, withTraceCarrier } from "../runs/run-store.ts";
import { rowToRun } from "../runs/postgres-run-store.ts";
import {
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
import { noticePayload } from "../persistence/postgres-notify-bus.ts";
import { TURN_QUEUES, tenantQueue, type TurnQueue } from "./absurd-schema.ts";
import { turnFenceHeld } from "./turn-fence.ts";

const TURN_TASK = "turn";
export const TURN_READY_CHANNEL = "qm_turn_ready";
export const TURN_CANCEL_CHANNEL = "qm_turn_cancel";
export const TURN_YIELD_CHANNEL = "qm_turn_yield";
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

const TURN_TENANT_QUEUES_MIGRATION = {
  id: "turns/0002-tenant-queues",
  statements: [
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
         'r_' || v_queue || COALESCE('_t' || left(replace(NULLIF(current_setting('qm.tenant_id', true), ''), '-', ''), 12), ''))
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
const BACKGROUND_PRIORITY: RunPriority = 2;

export interface TurnLedger {
  claim(queue: TurnQueue, token: string, workerId: string): Promise<{ claimed: boolean; run: Run | null }>;
  admit(input: EnqueueInput & { priority: RunPriority }): Promise<EnqueueResult>;
  extend(run: Run, token: string): Promise<ExtendOutcome>;
  handBack(
    run: Run,
    token: string,
    opts: { stop?: RunStop; delayMs?: number; countsAsError?: boolean; unstarted?: boolean },
  ): Promise<boolean>;
  finish(run: Run, token: string, outcome: TurnOutcome): Promise<boolean>;
  fenceHeld(turnId: string, token: string, client?: PoolClient): Promise<boolean>;
  cancel(turnId: string): Promise<"withdrawn" | "cancelled" | "signalled" | null>;
  /** Cancels the turn only if it has not started, checked under the thread's lock. */
  withdraw(turnId: string, opts?: { unstartedOnly?: boolean }): Promise<boolean>;
  cancelTree(threadRefs: readonly string[]): Promise<number>;
  repairCandidates(limit?: number): Promise<RepairCandidate[]>;
  adoptLegacy(limit?: number): Promise<number>;
  repair(candidate: RepairCandidate, result: TurnResult): Promise<Run | null>;
  release(candidate: RepairCandidate): Promise<void>;
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

function turnQueueFor(priority: RunPriority): TurnQueue {
  return QUEUE_BY_PRIORITY[priority];
}

function resumeEvent(turnId: string, parkings: number): string {
  return `resume:${turnId}:${parkings}`;
}

function queueOf(run: Pick<Run, "absurdQueue">): TurnQueue {
  const queue = run.absurdQueue;
  if (!queue || !(TURN_QUEUES as readonly string[]).includes(queue)) throw new Error("turn has no Absurd queue");
  return queue as TurnQueue;
}

function absurdTable(queue: TurnQueue, prefix: "r_" | "t_"): string {
  return `absurd.${pg.escapeIdentifier(prefix + tenantQueue(queue))}`;
}

function repairReason(row: Record<string, unknown>): string {
  if (row.turn == null) return "turn row missing";
  if (row.status !== "pending" && row.status !== "running") return `turn is ${String(row.status)}`;
  if (row.absurd_task_id == null) return "turn has no Absurd task";
  return `Absurd task ${String(row.task_state ?? "missing")}`;
}

const POINTER_KEY = "tenant_id = qm_tenant_id() AND thread_ref = $1";

interface LedgerContext {
  db: PgPool;
  tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Re-reads an ended turn and tells the run store's terminal listeners. */
  settle(id: string): Promise<Run | null>;
}

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
}

async function lockTurn(client: PoolClient, turnId: string): Promise<void> {
  await client.query("SELECT 1 FROM runs WHERE id = $1 FOR NO KEY UPDATE", [turnId]);
}

async function start(client: PoolClient, run: Run): Promise<void> {
  const queue = queueOf(run);
  const tenant = await client.query("SELECT qm_tenant_id()::text AS id");
  const params: TurnTaskParams = { tenantId: String(tenant.rows[0]!.id), turnId: run.id };
  const spawned = await spawnTask(client, queue, TURN_TASK, params, {
    idempotencyKey: run.id,
    maxAttempts: TURN_MAX_ATTEMPTS,
  });
  await client.query(`UPDATE runs SET status = 'pending', absurd_task_id = $2 WHERE id = $1`, [run.id, spawned.taskId]);
  await point(client, run.sessionId, run.id);
  await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, noticePayload(JSON.stringify(queue))]);
}

async function advance(client: PoolClient, threadRef: string, ending: string): Promise<void> {
  const parked = await client.query(
    `SELECT * FROM runs WHERE session_id = $1 AND engine = 'absurd' AND status = 'pending' AND id <> $2
       AND absurd_task_id IS NOT NULL AND (last_stop::jsonb)->>'kind' = 'parked'
     ORDER BY created_at ASC, seq ASC LIMIT 1 FOR UPDATE`,
    [threadRef, ending],
  );
  if (parked.rows[0]) {
    const run = rowToRun(parked.rows[0]);
    const queue = queueOf(run);
    await point(client, threadRef, run.id);
    await emitEvent(client, queue, resumeEvent(run.id, run.preemptions), { turnId: run.id });
    await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, noticePayload(JSON.stringify(queue))]);
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
  await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, noticePayload(JSON.stringify(queue))]);
}

async function askToYield(client: PoolClient, activeId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT * FROM runs WHERE id = $1 AND engine = 'absurd' AND claim_priority = $2 AND status IN ('pending','running')
     FOR UPDATE`,
    [activeId, BACKGROUND_PRIORITY],
  );
  if (!rows[0]) return false;
  if (rows[0].status === "running") {
    await client.query("SELECT pg_notify($1, $2)", [TURN_YIELD_CHANNEL, noticePayload(JSON.stringify(activeId))]);
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
         attempts = attempts + 1, started_at = COALESCE(started_at, $4), absurd_run_id = $5
       WHERE id = $1 AND engine = 'absurd' AND absurd_queue = $6 AND status IN ('pending','running')
       RETURNING *`,
      [turnId, token, workerId, Date.now(), absurdRunId, queue],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  });
}

async function legacyLeased(client: PoolClient, threadRef: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM runs WHERE session_id = $1 AND engine = 'legacy' AND status = 'running' AND lease_expires_at > $2
     LIMIT 1`,
    [threadRef, Date.now()],
  );
  return rows.length > 0;
}

// A run the legacy engine enqueued becomes a queued Absurd turn once no old process holds it: pending rows at once,
// running rows when their lease lapses. The thread then starts its oldest queued turn if none is active.
async function adoptThread(client: PoolClient, threadRef: string): Promise<number> {
  const active = await lockPointer(client, threadRef);
  if (await legacyLeased(client, threadRef)) return 0;
  const { rowCount } = await client.query(
    `UPDATE runs SET engine = 'absurd', status = 'queued', absurd_queue = ($2::text[])[claim_priority + 1],
       lease_token = NULL, lease_expires_at = NULL, worker_id = NULL,
       last_stop = COALESCE(last_stop, CASE WHEN status = 'running' THEN $3 END)
     WHERE session_id = $1 AND engine = 'legacy' AND status IN ('pending','running')`,
    [threadRef, [0, 1, 2].map((p) => turnQueueFor(p as RunPriority)), JSON.stringify({ kind: "lease_expired" })],
  );
  if (active === null) await advance(client, threadRef, "");
  return rowCount ?? 0;
}

async function cancelLocked(
  client: PoolClient,
  run: Run,
  active: string | null,
): Promise<{ outcome: "withdrawn" | "cancelled" | "signalled"; settled: boolean } | null> {
  if (run.status === "queued" && run.attempts === 0) {
    await client.query("DELETE FROM runs WHERE id = $1", [run.id]);
    if (active === run.id) await advance(client, run.sessionId, run.id);
    return { outcome: "withdrawn", settled: false };
  }
  if (run.status !== "queued" && run.status !== "pending" && run.status !== "running") return null;
  if (run.absurdTaskId) await cancelTask(client, queueOf(run), run.absurdTaskId);
  if (run.status === "running") {
    await client.query("SELECT pg_notify($1, $2)", [TURN_CANCEL_CHANNEL, noticePayload(JSON.stringify(run.id))]);
    return { outcome: "signalled", settled: false };
  }
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
    async admit({ sessionId, request, dedupKey, maxAttempts = 3, priority }) {
      return tx(async (client) => {
        const active = await lockPointer(client, sessionId);
        // The key's holder can release it between the conflict and the lookup, so look and insert until one lands.
        let inserted: Record<string, unknown> | undefined;
        while (!inserted) {
          if (dedupKey) {
            const { rows } = await client.query("SELECT * FROM runs WHERE idempotency_key = $1", [dedupKey]);
            if (rows[0]) return { run: rowToRun(rows[0]), deduped: true };
          }
          const { rows } = await client.query(
            `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at,
               claim_priority, engine, absurd_queue)
             VALUES ($1, $2, 'queued', $3, $4, 0, $5, $6, $7, 'absurd', $8)
             ON CONFLICT (${tenantCols("idempotency_key")}) DO NOTHING RETURNING *`,
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
          inserted = rows[0];
        }
        const queued = rowToRun(inserted);
        if (await legacyLeased(client, sessionId)) return { run: queued, deduped: false };
        if (active && !(priority === 0 && (await askToYield(client, active)))) return { run: queued, deduped: false };
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
      const run = await begin(ctx, queue, claimed.runId, params.turnId, token, workerId);
      if (run === "suspended") return { claimed: true, run: null };
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

    fenceHeld: async (turnId, token, client) => turnFenceHeld(client ?? ctx.db, turnId, token),

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

function cancellation(ctx: LedgerContext): Pick<TurnLedger, "cancel" | "withdraw" | "cancelTree"> {
  const { db, tx, settle } = ctx;
  async function cancelIf(turnId: string, allowed: (run: Run) => boolean) {
    const found = await db.query("SELECT session_id FROM runs WHERE id = $1", [turnId]);
    const threadRef = found.rows[0]?.session_id as string | undefined;
    if (!threadRef) return null;
    const done = await tx(async (client) => {
      const active = await lockPointer(client, threadRef);
      const { rows } = await client.query("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [turnId]);
      const run = rows[0] ? rowToRun(rows[0]) : null;
      return run && allowed(run) ? cancelLocked(client, run, active) : null;
    });
    if (done?.settled) await settle(turnId);
    return done?.outcome ?? null;
  }
  return {
    cancel: (turnId) => cancelIf(turnId, () => true),
    async withdraw(turnId, opts) {
      const unstarted = (run: Run) =>
        isUnstarted(run) && (!opts?.unstartedOnly || (run.attempts === 0 && run.turnUserSeq === null));
      return (await cancelIf(turnId, unstarted)) !== null;
    },

    async cancelTree(threadRefs) {
      const refs = [...new Set(threadRefs)].sort();
      if (!refs.length) return 0;
      const busy = await db.query(
        `SELECT DISTINCT session_id FROM runs WHERE session_id = ANY($1::text[])
           AND status IN ('queued','pending','running') ORDER BY session_id`,
        [refs],
      );
      if (!busy.rows.length) return 0;
      const settled: string[] = [];
      const count = await tx(async (client) => {
        const active = new Map<string, string | null>();
        for (const row of busy.rows)
          active.set(String(row.session_id), await lockPointer(client, String(row.session_id)));
        const { rows } = await client.query(
          `SELECT * FROM runs WHERE session_id = ANY($1::text[])
             AND status IN ('queued','pending','running') ORDER BY id FOR UPDATE`,
          [[...active.keys()]],
        );
        const rank = (run: Run): number => {
          if (run.status === "queued") return 0;
          return active.get(run.sessionId) === run.id ? 2 : 1;
        };
        const runs = rows.map(rowToRun).sort((a, b) => rank(a) - rank(b));
        let n = 0;
        for (const run of runs) {
          const current = await client.query("SELECT * FROM runs WHERE id = $1", [run.id]);
          if (!current.rows[0]) continue;
          const pointer = await client.query(`SELECT active_turn_id FROM session_turn_pointers WHERE ${POINTER_KEY}`, [
            run.sessionId,
          ]);
          const done = await cancelLocked(
            client,
            rowToRun(current.rows[0]),
            (pointer.rows[0]?.active_turn_id as string | null | undefined) ?? null,
          );
          if (!done) continue;
          n += 1;
          if (done.settled) settled.push(run.id);
        }
        return n;
      });
      for (const id of settled) await settle(id);
      return count;
    },
  };
}

function upkeep(
  ctx: LedgerContext,
): Pick<TurnLedger, "repairCandidates" | "adoptLegacy" | "repair" | "cleanup" | "release"> {
  const { db, tx, settle } = ctx;
  return {
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

    async adoptLegacy(limit = 100) {
      const { rows } = await db.query(
        `SELECT DISTINCT session_id FROM runs WHERE status IN ('pending','running','queued')
           AND ((engine = 'legacy' AND (status = 'pending' OR lease_expires_at <= $2))
             OR (status = 'queued' AND NOT EXISTS (
               SELECT 1 FROM session_turn_pointers p WHERE p.tenant_id = qm_tenant_id()
                 AND p.thread_ref = runs.session_id AND p.active_turn_id IS NOT NULL)))
         LIMIT $1`,
        [limit, Date.now()],
      );
      let adopted = 0;
      for (const row of rows) adopted += await tx((client) => adoptThread(client, String(row.session_id)));
      return adopted;
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
  const db: PgPool = createPgPool(connectionString, [TURN_LEDGER_MIGRATION, TURN_TENANT_QUEUES_MIGRATION]);
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
