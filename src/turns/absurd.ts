import pg from "pg";
import type { Pool, PoolClient } from "../persistence/pg-pool.ts";
import { errMessage } from "../util/errors.ts";
import { TURN_QUEUES, type TurnQueue } from "./absurd-schema.ts";

export type AbsurdDb = Pool | PoolClient;

export class TaskCancelled extends Error {
  override readonly name = "TaskCancelled";
}

export class RunFailed extends Error {
  override readonly name = "RunFailed";
}

type RetryStrategy =
  | { kind: "none" }
  | { kind: "fixed"; baseSeconds?: number }
  | { kind: "exponential"; baseSeconds?: number; factor?: number; maxSeconds?: number };

export interface SpawnOptions {
  idempotencyKey?: string;
  maxAttempts: number;
  retryStrategy?: RetryStrategy;
}

export interface SpawnedTask {
  taskId: string;
  runId: string;
  attempt: number;
  created: boolean;
}

export interface ClaimedRun {
  runId: string;
  taskId: string;
  attempt: number;
  taskName: string;
  params: unknown;
  maxAttempts: number | null;
  wakeEvent: string | null;
  eventPayload: unknown;
}

export interface AwaitedEvent {
  suspended: boolean;
  timedOut: boolean;
  payload: unknown;
}

export interface Checkpoint {
  state: unknown;
  status: string;
  ownerRunId: string;
  updatedAt: Date;
}

export interface CleanupResult {
  tasks: number;
  events: number;
}

function mapAbsurdError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "AB001") return new TaskCancelled(errMessage(error), { cause: error });
  if (code === "AB002") return new RunFailed(errMessage(error), { cause: error });
  return error;
}

async function call(db: AbsurdDb, text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return (await db.query(text, params)).rows as Record<string, unknown>[];
  } catch (error) {
    throw mapAbsurdError(error);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function runsTable(queue: TurnQueue): string {
  if (!TURN_QUEUES.includes(queue)) throw new Error(`absurd: unknown queue ${JSON.stringify(queue)}`);
  return `absurd.${pg.escapeIdentifier(`r_${queue}`)}`;
}

function retryStrategyJson(strategy: RetryStrategy): Record<string, unknown> {
  if (strategy.kind === "none") return { kind: "none" };
  if (strategy.kind === "fixed") return { kind: "fixed", base_seconds: strategy.baseSeconds };
  return {
    kind: "exponential",
    base_seconds: strategy.baseSeconds,
    factor: strategy.factor,
    max_seconds: strategy.maxSeconds,
  };
}

export async function spawnTask(
  db: AbsurdDb,
  queue: TurnQueue,
  name: string,
  params: unknown,
  options: SpawnOptions,
): Promise<SpawnedTask> {
  const spawnOptions = {
    idempotency_key: options.idempotencyKey,
    max_attempts: options.maxAttempts,
    retry_strategy: options.retryStrategy && retryStrategyJson(options.retryStrategy),
  };
  const [row] = await call(
    db,
    "SELECT task_id, run_id, attempt, created FROM absurd.spawn_task($1, $2, $3::jsonb, $4::jsonb)",
    [queue, name, json(params), JSON.stringify(spawnOptions)],
  );
  if (!row) throw new Error(`absurd: spawn_task returned no row for ${name}`);
  return {
    taskId: String(row.task_id),
    runId: String(row.run_id),
    attempt: Number(row.attempt),
    created: Boolean(row.created),
  };
}

export async function claimTasks(
  db: AbsurdDb,
  queue: TurnQueue,
  workerToken: string,
  claimTimeoutSec: number,
  qty = 1,
): Promise<ClaimedRun[]> {
  const rows = await call(
    db,
    `SELECT run_id, task_id, attempt, task_name, params, max_attempts, wake_event, event_payload
       FROM absurd.claim_task($1, $2, $3, $4)`,
    [queue, workerToken, claimTimeoutSec, qty],
  );
  return rows.map((row) => ({
    runId: String(row.run_id),
    taskId: String(row.task_id),
    attempt: Number(row.attempt),
    taskName: String(row.task_name),
    params: row.params,
    maxAttempts: row.max_attempts === null ? null : Number(row.max_attempts),
    wakeEvent: row.wake_event === null ? null : String(row.wake_event),
    eventPayload: row.event_payload,
  }));
}

export async function extendClaim(db: AbsurdDb, queue: TurnQueue, runId: string, extendBySec: number): Promise<void> {
  await call(db, "SELECT absurd.extend_claim($1, $2, $3)", [queue, runId, extendBySec]);
}

export async function scheduleRun(db: AbsurdDb, queue: TurnQueue, runId: string, wakeAt: Date): Promise<void> {
  await call(db, "SELECT absurd.schedule_run($1, $2, $3)", [queue, runId, wakeAt]);
}

export async function completeRun(db: AbsurdDb, queue: TurnQueue, runId: string, result?: unknown): Promise<void> {
  await call(db, "SELECT absurd.complete_run($1, $2, $3::jsonb)", [
    queue,
    runId,
    result === undefined ? null : json(result),
  ]);
}

export async function failRun(
  db: AbsurdDb,
  queue: TurnQueue,
  runId: string,
  reason: unknown,
  retryAt?: Date,
): Promise<void> {
  await call(db, "SELECT absurd.fail_run($1, $2, $3::jsonb, $4)", [queue, runId, json(reason), retryAt ?? null]);
}

export async function awaitEvent(
  db: AbsurdDb,
  queue: TurnQueue,
  taskId: string,
  runId: string,
  step: string,
  event: string,
  timeoutSec?: number,
): Promise<AwaitedEvent> {
  const [row] = await call(
    db,
    "SELECT should_suspend, NOT should_suspend AND payload IS NULL AS timed_out, payload FROM absurd.await_event($1, $2, $3, $4, $5, $6)",
    [queue, taskId, runId, step, event, timeoutSec ?? null],
  );
  if (!row) throw new Error(`absurd: await_event returned no row for ${event}`);
  return { suspended: Boolean(row.should_suspend), timedOut: Boolean(row.timed_out), payload: row.payload };
}

export async function emitEvent(db: AbsurdDb, queue: TurnQueue, event: string, payload?: unknown): Promise<void> {
  await call(db, "SELECT absurd.emit_event($1, $2, $3::jsonb)", [queue, event, json(payload)]);
}

export async function cancelTask(db: AbsurdDb, queue: TurnQueue, taskId: string): Promise<void> {
  await call(db, "SELECT absurd.cancel_task($1, $2)", [queue, taskId]);
}

export async function getCheckpoint(
  db: AbsurdDb,
  queue: TurnQueue,
  taskId: string,
  step: string,
): Promise<Checkpoint | undefined> {
  const [row] = await call(
    db,
    "SELECT state, status, owner_run_id, updated_at FROM absurd.get_task_checkpoint_state($1, $2, $3)",
    [queue, taskId, step],
  );
  if (!row) return undefined;
  return {
    state: row.state,
    status: String(row.status),
    ownerRunId: String(row.owner_run_id),
    updatedAt: row.updated_at as Date,
  };
}

export async function cleanup(db: AbsurdDb, queue: TurnQueue, ttlSec: number, limit: number): Promise<CleanupResult> {
  const [row] = await call(
    db,
    "SELECT absurd.cleanup_tasks($1, $2, $3) AS tasks, absurd.cleanup_events($1, $2, $3) AS events",
    [queue, ttlSec, limit],
  );
  return { tasks: Number(row?.tasks ?? 0), events: Number(row?.events ?? 0) };
}

export async function holdsClaim(db: PoolClient, queue: TurnQueue, runId: string, token: string): Promise<boolean> {
  const rows = await call(
    db,
    `SELECT 1 FROM ${runsTable(queue)} WHERE run_id = $1 AND state = 'running' AND claimed_by = $2 FOR SHARE`,
    [runId, token],
  );
  return rows.length > 0;
}
