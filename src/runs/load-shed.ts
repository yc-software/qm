import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface LoadShedGate {
  start(): void;
  stop(): void;
  canClaim(): boolean;
}

const SAMPLE_MS = 2_000;
export const SHED_AT_LAG_MS = 250;
export const RESUME_BELOW_LAG_MS = 100;

export function nextShedState(shedding: boolean, lagP99Ms: number): boolean {
  return shedding ? lagP99Ms >= RESUME_BELOW_LAG_MS : lagP99Ms >= SHED_AT_LAG_MS;
}

export function createLoadShedGate(opts: { sampleLagP99Ms?: () => number; sampleMs?: number } = {}): LoadShedGate {
  let shedding = false;
  const histogram = opts.sampleLagP99Ms ? null : monitorEventLoopDelay({ resolution: 20 });
  const sample =
    opts.sampleLagP99Ms ??
    (() => {
      const p99 = histogram!.percentile(99) / 1e6;
      histogram!.reset();
      return p99;
    });
  const sweeper: Sweeper = createSweeper(
    () => {
      const lag = sample();
      const next = nextShedState(shedding, lag);
      if (next !== shedding) {
        console.error(
          `[load-shed] event loop p99 lag ${Math.round(lag)}ms — ${next ? "pausing new run claims" : "resuming run claims"}`,
        );
        shedding = next;
      }
    },
    opts.sampleMs ?? SAMPLE_MS,
    { label: "load-shed" },
  );
  return {
    start: () => {
      histogram?.enable();
      sweeper.start();
    },
    stop: () => {
      sweeper.stop();
      histogram?.disable();
    },
    canClaim: () => !shedding,
  };
}
