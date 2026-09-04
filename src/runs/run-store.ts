import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";

type RunStatus = "pending" | "running" | "done" | "failed";

export interface ReapEvent {
  runId: string;
  sessionId: string;
  workerId: string | null;
  attempts: number;
  errorAttempts: number;
  outcome: "requeued" | "parked";
}

export interface RunDeliveryState {
  editRef?: string;
}

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  request: OrchestratorInput;
  result: TurnResult | null;
  deliveryState: RunDeliveryState | null;
  dedupKey: string | null;
  attempts: number;
  errorAttempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  workerId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
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
  readonly maxClaims?: number;

  enqueue(input: EnqueueInput): Promise<EnqueueResult>;

  claim(workerId: string, ttlMs: number): Promise<Run | null>;

  claimById(runId: string, workerId: string, ttlMs: number): Promise<Run | null>;

  heartbeat(runId: string, leaseToken: string, ttlMs: number): Promise<boolean>;

  releaseLease(runId: string, leaseToken: string): Promise<boolean>;

  complete(runId: string, leaseToken: string, result: TurnResult): Promise<boolean>;

  fail(runId: string, leaseToken: string, error: string, opts?: { retry?: boolean }): Promise<{ requeued: boolean }>;

  setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean>;

  onTerminal(listener: (run: Run) => void): void;

  get(runId: string): Promise<Run | null>;

  activeForThread(sessionId: string): Promise<Run | null>;

  inFlightForThread(sessionId: string): Promise<Run[]>;

  withdraw(runId: string): Promise<boolean>;

  activeSessionIds(): Promise<string[]>;

  list(opts?: { limit?: number }): Promise<Run[]>;

  reapExpired(
    onRetired?: (sessionIds: string[]) => Promise<void>,
    opts?: { maxAgeMs?: number; onReap?: (event: ReapEvent) => void },
  ): Promise<{ requeued: number; parked: number }>;

  waitFor(runId: string, timeoutMs?: number): Promise<Run>;

  close?(): Promise<void>;
}

const TERMINAL = new Set<Run["status"]>(["done", "failed"]);
export function isTerminal(status: Run["status"]): boolean {
  return TERMINAL.has(status);
}

export function errorParks(run: Pick<Run, "errorAttempts" | "maxAttempts" | "attempts">, maxClaims?: number): boolean {
  return run.errorAttempts + 1 >= run.maxAttempts || (maxClaims !== undefined && run.attempts >= maxClaims);
}

export function leaseLapsed(run: Pick<Run, "status" | "leaseExpiresAt">, asOf: number): boolean {
  return run.status === "running" && run.leaseExpiresAt !== null && run.leaseExpiresAt <= asOf;
}
