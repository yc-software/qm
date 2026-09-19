import type { InstanceRegistry } from "./instance-registry.ts";
import type { TaskProtection } from "./task-protection.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface DrainController {
  start(): void;
  stop(): Promise<void>;
  canClaim(): boolean;
  noteBusy(): void;
}

const DRAIN_SWEEP_MS = 10_000;

export function createDrainController(opts: {
  registry: InstanceRegistry;
  protection: TaskProtection | null;
  busy: () => boolean;
  onSuperseded?: (superseded: boolean) => void;
  sweepMs?: number;
}): DrainController {
  let superseded = false;
  let protectionOn = false;
  const sweeper: Sweeper = createSweeper(
    async () => {
      const wasSuperseded = superseded;
      superseded = await opts.registry.beat();
      if (superseded !== wasSuperseded) {
        opts.onSuperseded?.(superseded);
        console.error(
          `[drain] ${superseded ? "newer build is live — handing off background work" : "newer build gone — resuming background work"}`,
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
    stop: async () => {
      await sweeper.stop();
      if (protectionOn && opts.protection) {
        protectionOn = false;
        await opts.protection.set(false);
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
