import type { InstanceRegistry } from "./instance-registry.ts";
import type { TaskProtection } from "./task-protection.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface DrainController {
  start(): void;
  stop(): void;
  canClaim(): boolean;
  noteBusy(): void;
}

const DRAIN_SWEEP_MS = 10_000;

export function createDrainController(opts: {
  registry: InstanceRegistry;
  protection: TaskProtection | null;
  busy: () => boolean;
  sweepMs?: number;
}): DrainController {
  let superseded = false;
  let protectionOn = false;
  const sweeper: Sweeper = createSweeper(
    async () => {
      const wasSuperseded = superseded;
      superseded = await opts.registry.beat();
      if (superseded !== wasSuperseded) {
        console.error(
          `[drain] ${superseded ? "newer build is live — draining: no new run claims, finishing in-flight turns" : "newer build gone — resuming run claims"}`,
        );
      }
      if (!opts.protection) return;
      const busy = opts.busy();
      if (busy) {
        await opts.protection.set(true);
        protectionOn = true;
      } else if (protectionOn) {
        await opts.protection.set(false);
        protectionOn = false;
      }
    },
    opts.sweepMs ?? DRAIN_SWEEP_MS,
    { label: "deploy-drain", immediate: true },
  );
  return {
    start: () => sweeper.start(),
    stop: () => {
      sweeper.stop();
      if (protectionOn && opts.protection) {
        protectionOn = false;
        void opts.protection.set(false);
      }
    },
    canClaim: () => !superseded,
    noteBusy: () => {
      if (!opts.protection || protectionOn) return;
      protectionOn = true;
      void opts.protection.set(true);
    },
  };
}
