import { performance } from "node:perf_hooks";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface LoadShedGate {
  start(): void;
  stop(): void;
  canClaim(): boolean;
}

export interface LoadSampler {
  start(): void;
  stop(): void;
  utilization(): number;
}

const SAMPLE_MS = 2_000;
export const SHED_AT_UTILIZATION = 0.85;
export const RESUME_BELOW_UTILIZATION = 0.6;

export function nextShedState(shedding: boolean, utilization: number): boolean {
  return shedding ? utilization >= RESUME_BELOW_UTILIZATION : utilization >= SHED_AT_UTILIZATION;
}

function eventLoopUtilizationSampler(): LoadSampler {
  let last = performance.eventLoopUtilization();
  return {
    start: () => {
      last = performance.eventLoopUtilization();
    },
    stop: () => {},
    utilization: () => {
      const now = performance.eventLoopUtilization();
      const delta = performance.eventLoopUtilization(now, last);
      last = now;
      return delta.utilization;
    },
  };
}

export function createLoadShedGate(opts: { sampler?: LoadSampler; sampleMs?: number } = {}): LoadShedGate {
  let shedding = false;
  const sampler = opts.sampler ?? eventLoopUtilizationSampler();
  const sweeper: Sweeper = createSweeper(
    () => {
      const utilization = sampler.utilization();
      const next = nextShedState(shedding, utilization);
      if (next !== shedding) {
        console.error(
          `[load-shed] event loop utilization ${Math.round(utilization * 100)}%; ${next ? "pausing new run claims" : "resuming run claims"}`,
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
