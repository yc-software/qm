import { randomUUID } from "node:crypto";
import type { Cron, TriggerInitiator } from "../types.ts";
import type { DurableTaskContext } from "../durable/tasks.ts";
import type { Scheduler, SchedulerDeps } from "./scheduler.ts";
import { cronFireThreadRef } from "./scheduler.ts";
import { recoverNextFireAt } from "./schedule.ts";
import { hashId } from "../util/crypto.ts";
import { errMessage } from "../util/errors.ts";

interface FireTask {
  initiator?: TriggerInitiator;
  cronId: string;
  fireKey: string;
  firedAt: number;
  scheduledAt?: number;
  scheduleKey: string;
}

type Fire = (
  cron: Cron,
  firedAt: number,
  fireKey: string,
  scheduledAt?: number,
  context?: DurableTaskContext,
  initiator?: TriggerInitiator,
) => Promise<{ authzFailed: boolean; deferred?: boolean }>;

function scheduleKey(cron: Cron): string {
  return hashId([JSON.stringify(cron.schedule), cron.workflowRevision ?? "legacy"], 16);
}

export function createDurableScheduler(deps: SchedulerDeps, fire: Fire): Scheduler {
  const tasks = deps.tasks!;
  const now = deps.now ?? Date.now;
  let accepting = true;
  let starting: Promise<void> = Promise.resolve();

  async function schedule(cronId: string): Promise<void> {
    const cron = await deps.crons.get(cronId);
    if (!cron?.enabled || cron.archived) return;
    const scheduledAt = recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt);
    if (scheduledAt === undefined) return;
    const revision = scheduleKey(cron);
    await tasks.spawn<FireTask>(
      "cron.fire",
      {
        cronId,
        scheduledAt,
        firedAt: scheduledAt,
        fireKey: `cron:${cronId}:${scheduledAt}`,
        scheduleKey: revision,
      },
      {
        idempotencyKey: `cron:${cronId}:${revision}:${scheduledAt}`,
        maxAttempts: null,
        at: Math.max(scheduledAt, cron.deferUntil ?? 0),
      },
    );
  }

  async function cancelFire(params: FireTask): Promise<void> {
    if (params.scheduledAt !== undefined) return;
    const { runs } = await deps.crons.listFires(params.cronId);
    const pending = runs.find((entry) => entry.fireKey === params.fireKey && entry.status === "running");
    if (pending)
      await deps.crons.recordFire(params.cronId, {
        ...pending,
        endedAt: now(),
        status: "refused",
        note: "the cron was disabled, archived, or rescheduled before this fire could finish",
      });
  }

  tasks.register<FireTask, void>("cron.fire", async (context, params) => {
    const accepted = await context.step("accept", async () => {
      const cron = await deps.crons.get(params.cronId);
      if (!cron?.enabled || cron.archived || scheduleKey(cron) !== params.scheduleKey) return null;
      if (
        params.scheduledAt !== undefined &&
        recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== params.scheduledAt
      )
        return null;
      return cron;
    });
    if (!accepted) {
      await context.step("cancel", () => cancelFire(params));
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const current = await deps.crons.get(params.cronId);
      if (!current?.enabled || current.archived || scheduleKey(current) !== params.scheduleKey) {
        await context.step("cancel", () => cancelFire(params));
        return;
      }
      const scoped: DurableTaskContext = {
        ...context,
        step: (name, work) => context.step(`attempt:${attempt}:${name}`, work),
      };
      const outcome = await fire(
        current,
        params.firedAt,
        params.fireKey,
        params.scheduledAt,
        scoped,
        params.initiator ??
          (params.scheduledAt === undefined ? { actorId: current.owner, liveActor: false } : undefined),
      );
      if (outcome.deferred) {
        await context.sleepFor(`busy:${attempt}`, 30);
        continue;
      }
      if (!outcome.authzFailed && params.scheduledAt !== undefined) {
        await context.step("advance", () => deps.crons.markFired(params.cronId, now(), params.scheduledAt));
      }
      await context.step("successor", () => schedule(params.cronId));
      return;
    }
  });

  const reconcile = async () => {
    for (const cron of await deps.crons.list()) {
      await schedule(cron.id);
      if (!cron.enabled || cron.archived) continue;
      const { runs } = await deps.crons.listFires(cron.id);
      for (const pending of runs.filter(
        (entry) => entry.status === "running" && entry.fireKey.startsWith(`cron:${cron.id}:manual:`),
      )) {
        await tasks.spawn<FireTask>(
          "cron.fire",
          {
            cronId: cron.id,
            fireKey: pending.fireKey,
            ...(pending.initiator ? { initiator: pending.initiator } : {}),
            firedAt: pending.firedAt,
            scheduleKey: scheduleKey(cron),
          },
          { idempotencyKey: pending.fireKey, maxAttempts: null },
        );
      }
    }
  };

  tasks.register<{ at: number }, void>("cron.maintenance", async (context, params) => {
    await context.step("schedules", reconcile);
    await context.step("maintenance", async () => {
      await deps.crons.pruneFires(params.at);
      await deps.sweepAsks?.(params.at);
    });
    await context.step("successor", async () => {
      const at = Math.max(params.at + 60_000, Math.floor(now() / 60_000) * 60_000 + 60_000);
      await tasks.spawn("cron.maintenance", { at }, { idempotencyKey: `cron:maintenance:${at}`, at });
    });
  });

  return {
    async tick(at = now()) {
      await reconcile();
      await deps.crons.pruneFires(at);
      await deps.sweepAsks?.(at);
    },
    async runNow(cronId, initiator) {
      if (!accepting || deps.admittedWork?.canRun() === false) return { started: false, reason: "unavailable" };
      const cron = await deps.crons.get(cronId);
      if (!cron || !cron.enabled || cron.archived) return { started: false, reason: "unavailable" };
      initiator ??= { actorId: cron.owner, liveActor: false };
      const firedAt = now();
      const fireKey = `cron:${cron.id}:manual:${randomUUID()}`;
      const begin = await deps.crons.beginFire(
        cronId,
        {
          fireKey,
          threadRef: cronFireThreadRef(cron.id, fireKey),
          firedAt,
          status: "running",
          ...(initiator ? { initiator } : {}),
        },
        { exclusive: true },
      );
      if (!begin.begun)
        return begin.running
          ? { started: false, reason: "already_running", running: begin.running }
          : { started: false, reason: "unavailable" };
      const { taskId } = await tasks.spawn<FireTask>(
        "cron.fire",
        { cronId, fireKey, firedAt, scheduleKey: scheduleKey(cron), ...(initiator ? { initiator } : {}) },
        { idempotencyKey: fireKey, maxAttempts: null },
      );
      const settled = tasks.result<void>(taskId).catch((error: unknown) => {
        console.error(`[scheduler] manual fire ${fireKey} failed:`, errMessage(error));
      });
      return { started: true, fireKey, settled };
    },
    notifyChanged(cronId) {
      void schedule(cronId).catch((error: unknown) => {
        console.error("[scheduler] schedule update failed:", errMessage(error));
      });
    },
    start() {
      accepting = true;
      starting = (async () => {
        await tasks.ready();
        await reconcile();
        const at = Math.floor(now() / 60_000) * 60_000;
        await tasks.spawn("cron.maintenance", { at }, { idempotencyKey: `cron:maintenance:${at}` });
      })();
    },
    ready: () => starting,
    async stopClaims() {
      accepting = false;
      await starting;
    },
    async drained() {
      await starting;
    },
    async stop() {
      accepting = false;
      await starting;
    },
  };
}
