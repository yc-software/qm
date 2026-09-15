import { performance } from "node:perf_hooks";
import { pooledClientsWaiting } from "../persistence/pg-pool.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface LoadShedGate {
  start(): void;
  stop(): void;
  canClaim(): boolean;
}

export interface LoadSample {
  utilization: number;
  waitingForDb: number;
}

export interface LoadSampler {
  start(): void;
  sample(): LoadSample;
}

const SAMPLE_MS = 2_000;
export const SHED_AT_UTILIZATION = 0.85;
export const RESUME_BELOW_UTILIZATION = 0.6;
export const SHED_AT_DB_WAITERS = 8;

export function nextShedState(shedding: boolean, s: LoadSample): boolean {
  if (shedding) return s.utilization >= RESUME_BELOW_UTILIZATION || s.waitingForDb > 0;
  return s.utilization >= SHED_AT_UTILIZATION || s.waitingForDb >= SHED_AT_DB_WAITERS;
}

function processLoadSampler(): LoadSampler {
  let last = performance.eventLoopUtilization();
  return {
    start: () => {
      last = performance.eventLoopUtilization();
    },
    sample: () => {
      const now = performance.eventLoopUtilization();
      const utilization = performance.eventLoopUtilization(now, last).utilization;
      last = now;
      return { utilization, waitingForDb: pooledClientsWaiting() };
    },
  };
}

export function createLoadShedGate(opts: { sampler?: LoadSampler; sampleMs?: number } = {}): LoadShedGate {
  let shedding = false;
  const sampler = opts.sampler ?? processLoadSampler();
  const sweeper: Sweeper = createSweeper(
    () => {
      const s = sampler.sample();
      const next = nextShedState(shedding, s);
      if (next !== shedding) {
        console.error(
          `[load-shed] event loop ${Math.round(s.utilization * 100)}% busy, ${s.waitingForDb} queries waiting for a connection; ${next ? "pausing new run claims" : "resuming run claims"}`,
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
    stop: () => sweeper.stop(),
    canClaim: () => !shedding,
  };
}
