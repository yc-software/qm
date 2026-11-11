import type { ReapEvent, RunStore } from "./run-store.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { ScopeId } from "../types.ts";
import type { Tenant } from "../tenants/context.ts";
import { createSweeper } from "../util/sweeper.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";

export const REAPER_LEASE_KEY = "runs:reaper";

function recordReapEvent(errors: ErrorLog, e: ReapEvent, tenant: Tenant): void {
  errors.record(tenant, {
    category: "runs",
    code: e.outcome === "parked" ? "run_reap_parked" : "run_reap_requeued",
    message: `run ${e.runId} ${e.outcome} (worker=${e.workerId ?? "none"}, attempts=${e.attempts}, error_attempts=${e.errorAttempts})`,
    scopeLabel: REAPER_LEASE_KEY as ScopeId,
    sessionId: e.sessionId,
  });
}

export interface Reaper {
  start(): void;
  stop(): Promise<void>;
  sweep(): Promise<{ requeued: number; parked: number }>;
}

export interface ReaperOptions {
  intervalMs: number;
  leaderLease: LeaderLease;
  maxAgeMs?: number;
  errors?: ErrorLog;
}

export function createReaper(runs: RunStore, opts: ReaperOptions): Reaper {
  const leaderLease = opts.leaderLease;
  const { errors } = opts;
  const reap = (): Promise<{ requeued: number; parked: number }> =>
    runs.reapExpired({
      ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(errors ? { onReap: (e: ReapEvent, tenant: Tenant) => recordReapEvent(errors, e, tenant) } : {}),
    });
  const sweeper = createSweeper(() => leaderLease.hold(REAPER_LEASE_KEY, reap), opts.intervalMs);
  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep: reap,
  };
}
