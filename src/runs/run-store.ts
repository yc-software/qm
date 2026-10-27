import type { RunSignal, RunSignalStore } from "./run-signal-store.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { isPersonAuthored } from "../core/turn-origin.ts";
import { traceCarrier } from "../../plugins/chassis/src/error-reporting.ts";

type RunStatus = "queued" | "pending" | "running" | "done" | "failed";

export type RunPriority = 0 | 1 | 2;
/** Crons treat a fire this old as stale, and a turn waiter gives up after it. */
export const RUN_MAX_AGE_MS = 24 * 60 * 60_000;
export const MAX_PREEMPTIONS = 3;

export function withTraceCarrier(request: OrchestratorInput): OrchestratorInput {
  const { trace: _stale, ...rest } = request;
  const trace = traceCarrier();
  return trace ? { ...rest, trace } : rest;
}

export function runPriority(request: OrchestratorInput, delegating: RunPriority | null): RunPriority {
  if (request.swarm || (request.delegatingRunId && delegating === null)) return 2;
  if (request.delegatingRunId) return delegating === 2 ? 2 : 1;
  return isPersonAuthored(request.origin.kind) ? 0 : 2;
}

export interface RunDeliveryState {
  replying?: boolean;
  editRef?: string;
  postedAt?: number;
}

export type RunStop =
  | { kind: "shutdown" }
  | { kind: "parked" }
  | { kind: "lease_expired" }
  | { kind: "error"; code?: string; status?: number };

export const PARKED: RunStop = { kind: "parked" };

export function stopErrorCode(stop: RunStop | undefined): { errorCode?: string } {
  return stop?.kind === "error" && stop.code ? { errorCode: stop.code } : {};
}

export function handbackStop(shutdown: AbortSignal): RunStop {
  return shutdown.reason === PARKED ? PARKED : { kind: "shutdown" };
}

export interface Run {
  id: string;
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
  leaseToken: string | null;
  workerId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastStop?: RunStop | null;
  absurdQueue: string | null;
  absurdTaskId: string | null;
  absurdRunId: string | null;
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

export interface RunStore {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  getByDedupKey(dedupKey: string): Promise<Run | null>;

  setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean>;

  noteTurnUserSeq(runId: string, seq: number): Promise<boolean>;

  latestForThreads(
    threadRefs: readonly string[],
    opts?: { excludePrivateMessages?: boolean },
  ): Promise<Map<string, Run>>;
  latestForThread(threadRef: string, opts?: { excludePrivateMessages?: boolean }): Promise<Run | null>;
  pendingReturns(limit?: number, afterId?: string): Promise<Run[]>;
  terminalFinished(after: TerminalCursor, beforeMs: number, limit: number): Promise<Run[]>;
  markReturned(runId: string): Promise<void>;
  deferReturn(runId: string, delayMs: number): Promise<void>;

  onTerminal(listener: (run: Run) => void): void;
  emitTerminal(run: Run): void;
  leaseHeld(run: Run, token: string): Promise<boolean>;
  cancelTree(threadRefs: readonly string[]): Promise<number>;
  cancelTurn(runId: string): Promise<unknown>;

  get(runId: string): Promise<Run | null>;

  activeForThread(sessionId: string): Promise<Run | null>;

  inFlightForThread(sessionId: string): Promise<Run[]>;

  withdraw(runId: string, opts?: { unstartedOnly?: boolean }): Promise<boolean>;
  steerQueued(queuedRunId: string, targetRunId: string, signal: RunSignal, signals: RunSignalStore): Promise<boolean>;

  editPendingText(runId: string, text: string, expectedText: string): Promise<boolean>;

  activeSessionIds(): Promise<string[]>;

  list(opts?: { limit?: number; threadRef?: string }): Promise<Run[]>;

  close?(): Promise<void>;
}

const TERMINAL = new Set<Run["status"]>(["done", "failed"]);
export function isUnstarted(run: Pick<Run, "status" | "attempts" | "turnUserSeq">): boolean {
  if (run.status === "queued") return true;
  return run.status === "pending" && run.attempts === 0 && run.turnUserSeq === null;
}

export function isTerminal(status: Run["status"]): boolean {
  return TERMINAL.has(status);
}

export function releasesDedupKey(result: TurnResult): boolean {
  return result.refusalKind === "session_busy";
}

export function countedClaims(run: Pick<Run, "attempts" | "preemptions">): number {
  return run.attempts - run.preemptions;
}

export function errorParks(
  run: Pick<Run, "errorAttempts" | "maxAttempts" | "attempts" | "preemptions">,
  maxClaims?: number,
): boolean {
  return run.errorAttempts + 1 >= run.maxAttempts || (maxClaims !== undefined && countedClaims(run) >= maxClaims);
}

export function crashLoopReason(claims: number): string {
  return `run parked after ${claims} claims without completing (suspected crash loop)`;
}
