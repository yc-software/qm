import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

const LEASE_KEY = "insights:reach-denied:tick";
const CURSOR_KEY = "reach-denied-notify";
const TAIL_LIMIT = 200;

export interface ReachDeniedCursor {
  lastAt: number;
}

export interface ReachDeniedNotifierDeps {
  auditLog: AuditLog;
  cursors: DurableMap<ReachDeniedCursor>;
  notify: (e: AuditEvent) => Promise<void>;
  leaderLease?: LeaderLease;
  now?: () => number;
}

export function createReachDeniedNotifier(deps: ReachDeniedNotifierDeps): Sweeper {
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const sweep = async (): Promise<void> => {
    const cursor = (await deps.cursors.get(CURSOR_KEY)) ?? { lastAt: deps.now?.() ?? Date.now() };
    const fresh = (
      await deps.auditLog.tail({ limit: TAIL_LIMIT, action: "deployment.reach_denied", since: cursor.lastAt })
    )
      .slice()
      .sort((a, b) => a.at - b.at);
    for (const e of fresh) {
      await deps.notify(e);
      await deps.cursors.put(CURSOR_KEY, { lastAt: e.at });
    }
    if (fresh.length === 0 && !(await deps.cursors.get(CURSOR_KEY))) {
      await deps.cursors.put(CURSOR_KEY, cursor);
    }
  };
  return createSweeper(() => lease.hold(LEASE_KEY, () => sweep()), 60_000, {
    label: "reach-denied-notifier",
    immediate: true,
  });
}
