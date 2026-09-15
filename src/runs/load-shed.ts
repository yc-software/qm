import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface LoadShedGate {
  start(): void;
  stop(): void;
  canClaim(): boolean;
}

export interface LagSampler {
  start(): void;
  stop(): void;
  p99Ms(): number;
}

const SAMPLE_MS = 2_000;
export const SHED_AT_LAG_MS = 250;
export const RESUME_BELOW_LAG_MS = 100;

export function nextShedState(shedding: boolean, lagP99Ms: number): boolean {
  return shedding ? lagP99Ms >= RESUME_BELOW_LAG_MS : lagP99Ms >= SHED_AT_LAG_MS;
}

function eventLoopLagSampler(): LagSampler {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  return {
    start: () => {
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    },
    stop: () => {
      histogram?.disable();
      histogram = null;
    },
    p99Ms: () => {
      if (!histogram) return 0;
      const p99 = histogram.percentile(99) / 1e6;
      histogram.reset();
      return p99;
    },
  };
}

export function createLoadShedGate(opts: { sampler?: LagSampler; sampleMs?: number } = {}): LoadShedGate {
  let shedding = false;
  const sampler = opts.sampler ?? eventLoopLagSampler();
  const sweeper: Sweeper = createSweeper(
    () => {
      const lag = sampler.p99Ms();
      const next = nextShedState(shedding, lag);
      if (next !== shedding) {
        console.error(
          `[load-shed] event loop p99 lag ${Math.round(lag)}ms; ${next ? "pausing new run claims" : "resuming run claims"}`,
        );
        shedding = next;
      }
    },
    opts.sampleMs ?? SAMPLE_MS,
    { label: "load-shed" },
  );
  return {
    start: () => {
      sampler.start();
      sweeper.start();
    },
    stop: () => {
      sweeper.stop();
      sampler.stop();
    },
    canClaim: () => !shedding,
  };
}
