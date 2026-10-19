import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage } from "../util/errors.ts";

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
  let pg: PgPool | null = null;
  const boss = new PgBoss({
    schema,
    db: {
      executeSql: async (text, values) => {
        if (!pg) throw new Error("Cron queue database is closed");
        return (await pg.pool()).query(text, values);
      },
    },
  });
  async function closePool() {
    const previous = pg;
    pg = null;
    await previous?.close();
  }
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
      pg ??= createPgPool(databaseUrl, []);
      try {
        if (!initialized) {
          await boss.start();
          initialized = true;
        }
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
        if (initialized) {
          await boss.offWork(FIRE_QUEUE, { wait: false }).catch(() => {});
        } else {
          await boss.stop({ close: true, graceful: false }).catch(() => {});
          await closePool();
        }
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
      try {
        await boss.stop({ close: true, graceful: false });
      } finally {
        initialized = false;
        await closePool();
      }
    },
  };
}
