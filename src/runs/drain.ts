import type { InstanceRegistry } from "./instance-registry.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface DrainController {
  start(): void;
  stop(): Promise<void>;
  canClaim(): boolean;
}

const DRAIN_SWEEP_MS = 10_000;

export function createDrainController(opts: { registry: InstanceRegistry; sweepMs?: number }): DrainController {
  let superseded = false;
  const sweeper: Sweeper = createSweeper(
    async () => {
      const wasSuperseded = superseded;
      superseded = await opts.registry.beat();
      if (superseded !== wasSuperseded) {
        console.error(
          `[drain] ${superseded ? "newer build is live — draining: no new run claims, finishing in-flight turns" : "newer build gone — resuming run claims"}`,
        );
      }
    },
    opts.sweepMs ?? DRAIN_SWEEP_MS,
    { label: "deploy-drain", immediate: true },
  );
  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    canClaim: () => !superseded,
  };
}
