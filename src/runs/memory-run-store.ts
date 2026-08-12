import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EnqueueInput, EnqueueResult, ReapEvent, Run, RunDeliveryState, RunStore } from "./run-store.ts";
import { isTerminal, leaseLapsed } from "./run-store.ts";
import type { LedgerBegin, ToolLedger } from "./tool-ledger.ts";

export interface MemoryRuntime {
  runs: RunStore;
  ledger: ToolLedger;
}

export function createMemoryRunStore(opts?: { maxClaims?: number }): MemoryRuntime {
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY;
  const runs = new Map<string, Run>();
  const byKey = new Map<string, string>();
  const ledger = new Map<string, string>();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const terminalListeners: Array<(run: Run) => void> = [];

  function sessionHasRunning(sessionId: string, exceptId?: string): boolean {
    for (const r of runs.values()) {
      if (r.sessionId === sessionId && r.status === "running" && r.id !== exceptId) return true;
    }
    return false;
  }

  function settle(run: Run): void {
    if (!isTerminal(run.status)) return;
    events.emit(run.id, run);
    for (const listener of terminalListeners) listener(run);
  }

  const store: RunStore = {
    ...(Number.isFinite(maxClaims) ? { maxClaims } : {}),

    async enqueue({ sessionId, request, dedupKey, maxAttempts = 3 }: EnqueueInput): Promise<EnqueueResult> {
      if (dedupKey) {
        const existingId = byKey.get(dedupKey);
        if (existingId) {
          const existing = runs.get(existingId);
          if (existing) return { run: existing, deduped: true };
        }
      }
      const run: Run = {
        id: randomUUID(),
        sessionId,
        status: "pending",
        request,
        result: null,
        deliveryState: null,
        dedupKey: dedupKey ?? null,
        attempts: 0,
        errorAttempts: 0,
        maxAttempts,
        leaseToken: null,
        leaseExpiresAt: null,
        workerId: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      runs.set(run.id, run);
      if (dedupKey) byKey.set(dedupKey, run.id);
      return { run, deduped: false };
    },

    async claim(workerId, ttlMs) {
      const pending = [...runs.values()]
        .filter((r) => r.status === "pending" && !sessionHasRunning(r.sessionId))
        .sort((a, b) => a.createdAt - b.createdAt);
      const run = pending[0];
      if (!run) return null;
      return lease(run, workerId, ttlMs);
    },

    async claimById(runId, workerId, ttlMs) {
      const run = runs.get(runId);
      if (!run || run.status !== "pending" || sessionHasRunning(run.sessionId)) return null;
      return lease(run, workerId, ttlMs);
    },

    async heartbeat(runId, leaseToken, ttlMs) {
      const run = runs.get(runId);
      if (!run || run.status !== "running" || run.leaseToken !== leaseToken) return false;
      run.leaseExpiresAt = Date.now() + ttlMs;
      return true;
    },

    async releaseLease(runId, leaseToken) {
      const run = runs.get(runId);
      if (!run || run.status !== "running" || run.leaseToken !== leaseToken) return false;
      run.status = "pending";
      run.leaseToken = null;
      run.leaseExpiresAt = null;
      run.workerId = null;
      return true;
    },

    async complete(runId, leaseToken, result) {
      const run = runs.get(runId);
      if (!run || run.leaseToken !== leaseToken) return false;
      run.status = "done";
      run.result = result;
      run.leaseToken = null;
      run.leaseExpiresAt = null;
      run.finishedAt = Date.now();
      settle(run);
      return true;
    },

    async fail(runId, leaseToken, error, opts) {
      const run = runs.get(runId);
      if (!run || run.leaseToken !== leaseToken) return { requeued: false };
      return { requeued: retire(run, error, opts?.retry !== false, { countsAsError: true }).requeued };
    },

    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState) {
      const run = runs.get(runId);
      if (!run) return false;
      if (leaseToken !== null && run.leaseToken !== leaseToken) return false;
      run.deliveryState = state;
      return true;
    },

    onTerminal(listener) {
      terminalListeners.push(listener);
    },

    async get(runId) {
      return runs.get(runId) ?? null;
    },

    async activeForThread(sessionId) {
      return (
        [...runs.values()]
          .filter((r) => r.sessionId === sessionId && !isTerminal(r.status))
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
      );
    },

    async inFlightForThread(sessionId) {
      return [...runs.values()]
        .filter((r) => r.sessionId === sessionId && !isTerminal(r.status))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async withdraw(runId) {
      const run = runs.get(runId);
      if (!run || run.status !== "pending") return false;
      runs.delete(runId);
      if (run.dedupKey) byKey.delete(run.dedupKey);
      return true;
    },

    async activeSessionIds() {
      const ids = new Set<string>();
      for (const r of runs.values()) if (!isTerminal(r.status)) ids.add(r.sessionId);
      return [...ids];
    },

    async list({ limit = 200 }: { limit?: number } = {}) {
      return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },

    async reapExpired(
      onRetired?: (sessionIds: string[]) => Promise<void>,
      opts?: { maxAgeMs?: number; onReap?: (event: ReapEvent) => void },
    ) {
      const now = Date.now();
      const expired = [...runs.values()].filter((run) => leaseLapsed(run, now));
      let requeued = 0;
      let parked = 0;
      const retiredSessionIds: string[] = [];
      for (const run of expired) {
        const tooOld = opts?.maxAgeMs !== undefined && run.startedAt !== null && now - run.startedAt > opts.maxAgeMs;
        const reason = tooOld ? "run exceeded max age (reaped)" : "lease expired (reaped)";
        const workerId = run.workerId;
        const r = retire(run, reason, !tooOld, { ifExpiredAt: now });
        if (!r.applied) continue;
        if (r.requeued) requeued++;
        else parked++;
        retiredSessionIds.push(run.sessionId);
        opts?.onReap?.({
          runId: run.id,
          sessionId: run.sessionId,
          workerId,
          attempts: run.attempts,
          errorAttempts: run.errorAttempts,
          outcome: r.requeued ? "requeued" : "parked",
        });
      }
      if (onRetired && retiredSessionIds.length) await onRetired(retiredSessionIds);
      return { requeued, parked };
    },

    waitFor(runId, timeoutMs = 60_000) {
      const run = runs.get(runId);
      if (run && isTerminal(run.status)) return Promise.resolve(run);
      return new Promise<Run>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          events.off(runId, onSettle);
          reject(new Error(`run ${runId} did not finish within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        function onSettle(r: Run): void {
          clearTimeout(timer);
          resolvePromise(r);
        }
        events.once(runId, onSettle);
      });
    },
  };

  function lease(run: Run, workerId: string, ttlMs: number): Run {
    run.status = "running";
    run.leaseToken = randomUUID();
    run.leaseExpiresAt = Date.now() + ttlMs;
    run.workerId = workerId;
    run.attempts += 1;
    run.startedAt = run.startedAt ?? Date.now();
    return { ...run };
  }

  function retire(
    run: Run,
    error: string,
    retry: boolean,
    opts?: { ifExpiredAt?: number; countsAsError?: boolean },
  ): { requeued: boolean; applied: boolean } {
    if (run.status !== "running") return { requeued: false, applied: false };
    if (opts?.ifExpiredAt !== undefined && (run.leaseExpiresAt === null || run.leaseExpiresAt > opts.ifExpiredAt)) {
      return { requeued: false, applied: false };
    }
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    run.workerId = null;
    if (opts?.countsAsError) run.errorAttempts += 1;
    const overClaimed = run.attempts >= maxClaims;
    if (retry && run.errorAttempts < run.maxAttempts && !overClaimed) {
      run.status = "pending";
      return { requeued: true, applied: true };
    }
    run.status = "failed";
    const reason =
      !opts?.countsAsError && overClaimed && retry && run.errorAttempts < run.maxAttempts
        ? `run parked after ${run.attempts} claims without completing (suspected crash loop)`
        : error;
    run.result = { status: "failed", sessionId: run.sessionId, reason };
    run.finishedAt = Date.now();
    settle(run);
    return { requeued: false, applied: true };
  }

  const toolLedger: ToolLedger = {
    async begin(runId, attempt, callIndex): Promise<LedgerBegin> {
      const output = ledger.get(`${runId}:${attempt}:${callIndex}`);
      return output !== undefined ? { cached: true, output } : { cached: false };
    },
    async record(runId, attempt, callIndex, output) {
      ledger.set(`${runId}:${attempt}:${callIndex}`, output);
    },
  };

  return { runs: store, ledger: toolLedger };
}
