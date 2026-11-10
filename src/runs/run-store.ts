import type { SubscribeOptions } from "../util/event-bus.ts";
import type { RunSignal, RunSignalStore } from "./run-signal-store.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { isPersonAuthored } from "../core/turn-origin.ts";
import { traceCarrier } from "../../plugins/chassis/src/error-reporting.ts";
import { sleep } from "../util/async.ts";

type RunStatus = "pending" | "running" | "done" | "failed";

export type RunPriority = 0 | 1 | 2;
export const MAX_PREEMPTIONS = 3;

export function withTraceCarrier(request: OrchestratorInput): OrchestratorInput {
  const { trace: _stale, ...rest } = request;
  const trace = request.swarm ? undefined : traceCarrier();
  return trace ? { ...rest, trace } : rest;
}

export function runPriority(request: OrchestratorInput, delegating: RunPriority | null): RunPriority {
  if (request.swarm || (request.delegatingRunId && delegating === null)) return 2;
  if (request.delegatingRunId) return delegating === 2 ? 2 : 1;
  return isPersonAuthored(request.origin.kind) ? 0 : 2;
}

export interface ReapEvent {
  runId: string;
  sessionId: string;
  workerId: string | null;
  attempts: number;
  errorAttempts: number;
  outcome: "requeued" | "parked";
}

export interface RunDeliveryState {
  replying?: boolean;
  editRef?: string;
}

export type RunStop =
  | { kind: "shutdown" }
  | { kind: "parked" }
  | { kind: "lease_expired" }
  | { kind: "error"; code?: string; status?: number };

export const PARKED: RunStop = { kind: "parked" };

export const CRASHED = { kind: "crashed" } as const;

export interface TurnPark {
  requested(): boolean;
  now(): void;
}

export function stopErrorCode(stop: RunStop | undefined): { errorCode?: string } {
  return stop?.kind === "error" && stop.code ? { errorCode: stop.code } : {};
}

export function handbackStop(shutdown: AbortSignal): RunStop {
  return shutdown.reason === PARKED ? PARKED : { kind: "shutdown" };
}

export interface Run {
  id: string;
  tenantId: string;
  sessionId: string;
  status: RunStatus;
  request: OrchestratorInput;
  result: TurnResult | null;
  deliveryState: RunDeliveryState | null;
  turnUserSeq: number | null;
  dedupKey: string | null;
  attempts: number;
  errorAttempts: number;
  maxAttempts: number;
  priority: RunPriority;
  preemptions: number;
  handbacks: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  workerId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastStop?: RunStop | null;
}

interface TerminalCursor {
  finishedAt: number;
  id: string;
}

export interface EnqueueInput {
  sessionId: string;
  request: OrchestratorInput;
  dedupKey?: string;
  maxAttempts?: number;
}

export interface EnqueueResult {
  run: Run;
  deduped: boolean;
}

export const RUN_WAIT_FALLBACK_MS = 2_000;

export interface SessionWatch {
  changed(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface RunStore {
  readonly maxClaims?: number;

  subscribeAvailable?(listener: () => void, options?: SubscribeOptions & { pollMs?: number }): () => void;
  watchSession(sessionId: string): SessionWatch;

  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  getByDedupKey(dedupKey: string): Promise<Run | null>;

  claim(workerId: string, ttlMs: number, limit?: number): Promise<Run[]>;

  claimById(runId: string, workerId: string, ttlMs: number): Promise<Run | null>;

  personWaiting(createdBefore: number): Promise<boolean>;

  personWaitingIn(sessionIds: readonly string[], createdBefore: number): Promise<Set<string>>;

  heartbeat(runId: string, leaseToken: string, ttlMs: number): Promise<boolean>;

  releaseLease(runId: string, leaseToken: string, stop?: RunStop, retryAfter?: number): Promise<boolean>;

  complete(runId: string, leaseToken: string, result: TurnResult): Promise<boolean>;

  fail(
    runId: string,
    leaseToken: string,
    error: string,
    opts?: { retry?: boolean; retryAfterMs?: number; stop?: RunStop },
  ): Promise<{ requeued: boolean }>;

  setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean>;

  noteTurnUserSeq(runId: string, seq: number): Promise<boolean>;

  activeForThreads(threadRefs: readonly string[]): Promise<Map<string, Run>>;
  lastFinishedForThreads(threadRefs: readonly string[]): Promise<Map<string, Run>>;
  pendingReturns(limit?: number, afterId?: string, threadRefs?: readonly string[]): Promise<Run[]>;
  terminalFinished(after: TerminalCursor, beforeMs: number, limit: number): Promise<Run[]>;
  markReturned(runId: string): Promise<void>;
  deferReturn(runId: string, delayMs: number): Promise<void>;

  onTerminal(listener: (run: Run) => void): void;

  get(runId: string): Promise<Run | null>;

  activeForThread(sessionId: string): Promise<Run | null>;

  inFlightForThread(sessionId: string): Promise<Run[]>;

  withdraw(runId: string, opts?: { unstartedOnly?: boolean }): Promise<boolean>;
  steerQueued(queuedRunId: string, targetRunId: string, signal: RunSignal, signals: RunSignalStore): Promise<boolean>;

  editPendingText(runId: string, text: string, expectedText: string): Promise<boolean>;

  activeSessionIds(): Promise<string[]>;

  list(opts?: { limit?: number; threadRef?: string }): Promise<Run[]>;

  reapExpired(opts?: {
    maxAgeMs?: number;
    onReap?: (event: ReapEvent) => void;
  }): Promise<{ requeued: number; parked: number }>;

  waitFor(runId: string, timeoutMs?: number): Promise<Run>;

  close?(): Promise<void>;
}

const TERMINAL = new Set<Run["status"]>(["done", "failed"]);
export function isTerminal(status: Run["status"]): boolean {
  return TERMINAL.has(status);
}

const IDLE_POLL_MS = 250;

export async function hasRunningRun(
  runs: Pick<RunStore, "inFlightForThread">,
  threadRef: string,
  exceptLeaseToken?: string,
): Promise<boolean> {
  return (await runs.inFlightForThread(threadRef)).some(
    (run) => run.status === "running" && (exceptLeaseToken === undefined || run.leaseToken !== exceptLeaseToken),
  );
}

export async function waitForNoRunningRun(
  runs: Pick<RunStore, "inFlightForThread">,
  threadRef: string,
  budgetMs: number,
  exceptLeaseToken?: string,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (await hasRunningRun(runs, threadRef, exceptLeaseToken)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(IDLE_POLL_MS, deadline - Date.now()), { unref: true });
  }
  return true;
}

export function countedClaims(run: Pick<Run, "attempts" | "handbacks">): number {
  return run.attempts - run.handbacks;
}

export function errorParks(
  run: Pick<Run, "errorAttempts" | "maxAttempts" | "attempts" | "handbacks">,
  maxClaims?: number,
): boolean {
  return run.errorAttempts + 1 >= run.maxAttempts || (maxClaims !== undefined && countedClaims(run) >= maxClaims);
}

export function leaseLapsed(run: Pick<Run, "status" | "leaseExpiresAt">, asOf: number): boolean {
  return run.status === "running" && run.leaseExpiresAt !== null && run.leaseExpiresAt <= asOf;
}
