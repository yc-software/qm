import { PgBoss } from "pg-boss";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { errMessage } from "../util/errors.ts";

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
}

interface CronQueueHandlers {
  onFire(job: CronFireJob): Promise<void>;
  onTick(): Promise<void>;
}

export interface CronJobQueue {
  start(handlers: CronQueueHandlers, tickIntervalMs: number): Promise<void>;
  enqueueFire(job: CronFireJob): Promise<void>;
  healthy(): boolean;
  stop(): Promise<void>;
}

const HEALTHY_SEND_MAX_AGE_MS = 30_000;

const FIRE_QUEUE = "cron-fire";
const TICK_QUEUE = "cron-tick";
const CRON_TICK_SECONDS = 5;

export function createPgBossCronQueue(
  databaseUrl: string,
  schema: string = "pgboss",
  fireConcurrency: number = 1,
): CronJobQueue {
  const boss = new PgBoss({ connectionString: databaseUrl, schema, max: 5 });
  boss.on("error", (e) => console.error("[cron-queue] pg-boss error:", errMessage(e)));
  let ticker: Sweeper | null = null;
  let started = false;
  let lastSendOkAt = 0;
  return {
    async start(handlers, tickIntervalMs) {
      await boss.start();
      try {
        await boss.createQueue(FIRE_QUEUE, { policy: "short", notify: true });
        await boss.createQueue(TICK_QUEUE, { policy: "short", notify: true });
        const localConcurrency = Math.min(32, Math.max(1, Math.trunc(fireConcurrency)));
        await boss.work<CronFireJob>(
          FIRE_QUEUE,
          { pollingIntervalSeconds: 1, batchSize: 1, localConcurrency },
          async (jobs) => {
            for (const job of jobs) await handlers.onFire(job.data);
          },
        );
        await boss.work(TICK_QUEUE, { pollingIntervalSeconds: 1 }, () => handlers.onTick());
      } catch (e) {
        await boss.stop({ close: true, graceful: false }).catch(() => {});
        throw e;
      }
      started = true;
      lastSendOkAt = Date.now();
      ticker = createSweeper(
        () =>
          boss
            .send(TICK_QUEUE, {}, { singletonSeconds: CRON_TICK_SECONDS, retryLimit: 0, expireInSeconds: 60 })
            .then(() => {
              lastSendOkAt = Date.now();
            }),
        tickIntervalMs,
        { label: "cron-queue ticker", immediate: true },
      );
      ticker.start();
    },
    async enqueueFire(job) {
      if (!started) return;
      await boss.send(FIRE_QUEUE, job, {
        startAfter: new Date(job.scheduledAt),
        singletonKey: `${job.cronId}:${job.scheduledAt}`,
        retryLimit: 0,
      });
    },
    healthy() {
      return started && Date.now() - lastSendOkAt < HEALTHY_SEND_MAX_AGE_MS;
    },
    async stop() {
      started = false;
      ticker?.stop();
      await boss.stop({ close: true, graceful: false });
    },
  };
}
