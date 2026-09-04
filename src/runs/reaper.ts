import type { ReapEvent, RunStore } from "./run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { ScopeId } from "../types.ts";
import { createSweeper } from "../util/sweeper.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";

export const REAPER_LEASE_KEY = "runs:reaper";

function recordReapEvent(errors: ErrorLog, e: ReapEvent): void {
  errors.record({
    category: "runs",
    code: e.outcome === "parked" ? "run_reap_parked" : "run_reap_requeued",
    message: `run ${e.runId} ${e.outcome} (worker=${e.workerId ?? "none"}, attempts=${e.attempts}, error_attempts=${e.errorAttempts})`,
    scopeLabel: REAPER_LEASE_KEY as ScopeId,
    sessionId: e.sessionId,
  });
}

export interface Reaper {
  start(): void;
  stop(): void;
  sweep(): Promise<{ requeued: number; parked: number }>;
}

async function releaseStrandedSessionLeases(sessions: SessionStore, sessionIds: string[]): Promise<void> {
  for (const threadRef of new Set(sessionIds)) {
    const session = await sessions.getByThread(threadRef);
    if (session) await sessions.forceReleaseLease(session.id);
  }
}

export interface ReaperOptions {
  intervalMs: number;
  leaderLease?: LeaderLease;
  maxAgeMs?: number;
  errors?: ErrorLog;
}

export function createReaper(runs: RunStore, sessions: SessionStore, opts: ReaperOptions): Reaper {
  const leaderLease = opts.leaderLease ?? createNoopLeaderLease();
  const { errors } = opts;
  const reap = (): Promise<{ requeued: number; parked: number }> =>
    runs.reapExpired((retiredSessionIds) => releaseStrandedSessionLeases(sessions, retiredSessionIds), {
      ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(errors ? { onReap: (e: ReapEvent) => recordReapEvent(errors, e) } : {}),
    });
  const sweeper = createSweeper(() => leaderLease.hold(REAPER_LEASE_KEY, reap), opts.intervalMs);
  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep: reap,
  };
}
