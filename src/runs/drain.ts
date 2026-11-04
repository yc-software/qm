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
const WAITING_SWEEP_MS = 1_000;

export function createDrainController(opts: {
  registry: InstanceRegistry;
  sweepMs?: number;
  waitingSweepMs?: number;
}): DrainController {
  let superseded = false;
  let waiting = false;
  let applied: boolean | undefined;
  let settled = true;
  let services: BackgroundServices | undefined;
  let transition: Promise<void> | null = null;
  let reporting = false;
  let beats: Promise<unknown> = Promise.resolve();
  const beat = (): ReturnType<InstanceRegistry["beat"]> => {
    const next = beats.then(() => opts.registry.beat(reporting));
    beats = next.catch(() => {});
    return next;
  };
  const apply = async (target: boolean, current: BackgroundServices): Promise<void> => {
    if (superseded)
      console.error(
        "[drain] newer build is live — draining: no new run claims, cron fires or Slack connections; finishing in-flight turns",
      );
    else if (target)
      console.error(
        "[drain] an older build still runs background work — waiting for it to stand down before claiming runs, firing crons or connecting Slack",
      );
    else if (applied !== undefined)
      console.error(
        "[drain] no other build runs background work — resuming run claims, cron fires and Slack connections",
      );
    try {
      if (target || !settled) {
        await current.standDown();
        reporting = false;
        await beat();
      }
      if (!target) {
        reporting = true;
        const claimed = await beat();
        if (claimed.superseded || claimed.olderRunning) {
          superseded = claimed.superseded;
          waiting = !claimed.superseded;
          reporting = false;
          await beat();
          settled = true;
          applied = true;
          return;
        }
        current.resume();
      }
      settled = true;
      applied = target;
    } catch (error) {
      settled = false;
      applied = undefined;
      throw error;
    }
  };
  let ticking = false;
  const sweep = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    let heartbeat: Awaited<ReturnType<InstanceRegistry["beat"]>>;
    try {
      heartbeat = await beat();
    } finally {
      ticking = false;
    }
    superseded = heartbeat.superseded;
    waiting = !superseded && heartbeat.olderRunning && applied !== false;
    const target = superseded || waiting;
    if (transition || !services || target === applied) return;
    transition = apply(target, services).finally(() => {
      transition = null;
    });
    await transition;
  };
  const sweeper: Sweeper = createSweeper(sweep, opts.sweepMs ?? DRAIN_SWEEP_MS, {
    label: "deploy-drain",
    immediate: true,
  });
  const waitingSweeper: Sweeper = createSweeper(
    () => (waiting ? sweep() : undefined),
    opts.waitingSweepMs ?? WAITING_SWEEP_MS,
    { label: "deploy-drain-waiting" },
  );
  return {
    start(next) {
      services = next;
      applied = undefined;
      sweeper.start();
      waitingSweeper.start();
    },
    async stop() {
      const current = services;
      services = undefined;
      await Promise.all([sweeper.stop(), waitingSweeper.stop()]);
      if (current && applied !== true)
        await current.standDown().catch(reportFailureAs("deploy-drain: stand down on stop", undefined));
      reporting = false;
      await beats;
      await opts.registry.retire().catch(reportFailureAs("deploy-drain: retire heartbeat", undefined));
    },
    canClaim: () => !superseded && !waiting,
  };
}
