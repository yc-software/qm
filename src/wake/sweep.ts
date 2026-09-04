import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createNoopLeaderLease } from "../persistence/leader-lease.ts";

const SWEEP_LEASE_KEY = "wake:sweep";

export interface SweepSource {
  engagedSessions(): Promise<string[]>;
  sweepSession(threadRef: string): Promise<number>;
}

export interface WakeSweepOptions {
  intervalMs: number;
  leaderLease?: LeaderLease;
}

export interface WakeSweep {
  start(): void;
  stop(): void;
  sweep(): Promise<{ swept: number; fresh: number }>;
}

export function createWakeSweep(source: SweepSource, opts: WakeSweepOptions): WakeSweep {
  const leaderLease = opts.leaderLease ?? createNoopLeaderLease();

  const sweep = async (): Promise<{ swept: number; fresh: number }> => {
    const targets = await source.engagedSessions();
    let fresh = 0;
    for (const threadRef of targets) fresh += await source.sweepSession(threadRef);
    return { swept: targets.length, fresh };
  };

  const runPass = (): Promise<unknown> => leaderLease.hold(SWEEP_LEASE_KEY, sweep);

  const sweeper: Sweeper = createSweeper(runPass, opts.intervalMs, { label: "wake-sweep" });
  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep,
  };
}
