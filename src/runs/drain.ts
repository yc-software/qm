import type { InstanceRegistry } from "./instance-registry.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { reportFailureAs } from "../util/errors.ts";

export interface BackgroundServices {
  resume(): void;
  standDown(): Promise<void>;
}

export interface DrainController {
  start(services: BackgroundServices): void;
  stop(): Promise<void>;
  canClaim(): boolean;
}

const DRAIN_SWEEP_MS = 10_000;

export function createDrainController(opts: { registry: InstanceRegistry; sweepMs?: number }): DrainController {
  let superseded = false;
  let applied: boolean | undefined;
  let settled = true;
  let services: BackgroundServices | undefined;
  let transition: Promise<void> | null = null;
  const apply = async (target: boolean, current: BackgroundServices): Promise<void> => {
    if (applied !== undefined || target)
      console.error(
        `[drain] ${target ? "newer build is live — draining: no new run claims, cron fires or Slack connections; finishing in-flight turns" : "newer build gone — resuming run claims, cron fires and Slack connections"}`,
      );
    try {
      if (target || !settled) await current.standDown();
      if (!target) current.resume();
      settled = true;
      applied = target;
    } catch (error) {
      settled = false;
      applied = undefined;
      throw error;
    }
  };
  const sweeper: Sweeper = createSweeper(
    async () => {
      superseded = await opts.registry.beat();
      if (transition || !services || superseded === applied) return;
      transition = apply(superseded, services).finally(() => {
        transition = null;
      });
      await transition;
    },
    opts.sweepMs ?? DRAIN_SWEEP_MS,
    { label: "deploy-drain", immediate: true },
  );
  return {
    start(next) {
      services = next;
      applied = undefined;
      sweeper.start();
    },
    async stop() {
      services = undefined;
      await sweeper.stop();
      await opts.registry.retire().catch(reportFailureAs("deploy-drain: retire heartbeat", undefined));
    },
    canClaim: () => !superseded,
  };
}
