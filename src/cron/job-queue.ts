import { sharedPgBoss } from "../persistence/pg-boss.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

interface CronQueueHandlers {
  onFire(job: CronFireJob): Promise<void>;
}

export interface CronJobQueue {
  start(handlers: CronQueueHandlers): Promise<void>;
  enqueueFire(job: CronFireJob): Promise<void>;
  healthy(): boolean;
  stopClaims?(): Promise<void>;
  stop(): Promise<void>;
}

const UNHEALTHY_AFTER_ERROR_MS = 30_000;

const FIRE_QUEUE = "cron-fire";

export function createPgBossCronQueue(
  databaseUrl: string,
  schema: string = "pgboss",
  fireConcurrency: number = 1,
): CronJobQueue {
  const shared = sharedPgBoss(databaseUrl, schema);
  const boss = shared.boss;
  let started = false;
  let initialized = false;
  let lastErrorAt = 0;
  boss.on("error", (e) => {
    lastErrorAt = Date.now();
    console.error("[cron-queue] pg-boss error:", errMessage(e));
  });
  return {
    async start(handlers) {
      if (started) return;
      if (!initialized) {
        await shared.retain();
        initialized = true;
      }
      try {
        await boss.createQueue(FIRE_QUEUE, { policy: "short", notify: true });
        const localConcurrency = Math.min(32, Math.max(1, Math.trunc(fireConcurrency)));
        await boss.work<CronFireJob>(
          FIRE_QUEUE,
          { pollingIntervalSeconds: 1, batchSize: 1, localConcurrency },
          async (jobs) => {
            for (const job of jobs) await handlers.onFire(job.data);
          },
        );
      } catch (e) {
        await boss
          .offWork(FIRE_QUEUE, { wait: false })
          .catch(swallowAs("cron queue: stop worker after failed start", undefined));
        throw e;
      }
      started = true;
      lastErrorAt = 0;
    },
    async enqueueFire(job) {
      if (!started) return;
      await boss
        .send(FIRE_QUEUE, job, {
          startAfter: new Date(Math.max(job.scheduledAt, job.notBefore ?? 0)),
          singletonKey: `${job.cronId}:${job.scheduledAt}`,
          retryLimit: 0,
        })
        .catch((e: unknown) => {
          lastErrorAt = Date.now();
          throw e;
        });
    },
    healthy() {
      return started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS;
    },
    async stopClaims() {
      started = false;
      await boss.offWork(FIRE_QUEUE, { wait: false });
    },
    async stop() {
      started = false;
      if (!initialized) return;
      initialized = false;
      try {
        await boss.offWork(FIRE_QUEUE, { wait: false });
      } finally {
        await shared.release();
      }
    },
  };
}
