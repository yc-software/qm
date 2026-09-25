import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool, type PoolClient } from "../persistence/pg-pool.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { errMessage } from "../util/errors.ts";

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

interface CronQueueHandlers {
  onFire(job: CronFireJob): Promise<void>;
  onTick(): Promise<void>;
}

export interface CronJobQueue {
  start(handlers: CronQueueHandlers, tickIntervalMs: number): Promise<void>;
  enqueueFire(job: CronFireJob): Promise<void>;
  healthy(): boolean;
  stopClaims?(): Promise<void>;
  stop(): Promise<void>;
}

const HEALTHY_SEND_MAX_AGE_MS = 30_000;

const FIRE_QUEUE = "cron-fire";
const TICK_QUEUE = "cron-tick";
const CRON_TICK_SECONDS = 5;
const NOTIFY_POLLING_INTERVAL_SECONDS = 10;

async function listenForPgBoss(
  pool: PgPool,
  channel: string,
  onNotification: (payload: string) => void,
  onReconnect: () => void,
): Promise<{ close(): Promise<void> }> {
  let client: PoolClient | null = null;
  let closed = false;
  let established = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<void> | null = null;

  const release = () => {
    const previous = client;
    client = null;
    if (!previous) return;
    previous.release(true);
  };
  const schedule = () => {
    if (closed || retry) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retry = setTimeout(() => {
      retry = undefined;
      connecting = connect();
      void connecting.catch(() => schedule());
    }, delay);
    retry.unref?.();
  };
  const connect = async (): Promise<void> => {
    if (closed) return;
    const next = await (await pool.sessionPool()).connect();
    if (closed) {
      next.release(true);
      return;
    }
    client = next;
    const disconnect = () => {
      if (client !== next) return;
      release();
      if (established) {
        established = false;
        schedule();
      }
    };
    next.on("error", disconnect);
    next.on("end", disconnect);
    next.on("notification", (message) => {
      if (client === next && message.payload !== undefined) onNotification(message.payload);
    });
    try {
      await next.query(`LISTEN "${channel.replaceAll('"', '""')}"`);
      if (closed || client !== next) return;
      established = true;
      attempt = 0;
      onReconnect();
    } catch (error) {
      disconnect();
      throw error;
    }
  };
  connecting = connect();
  try {
    await connecting;
  } catch (error) {
    release();
    throw error;
  }
  return {
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      await connecting?.catch(() => undefined);
      release();
    },
  };
}

export function createPgBossCronQueue(
  databaseUrl: string,
  schema: string = "pgboss",
  fireConcurrency: number = 1,
): CronJobQueue {
  let pg: PgPool | null = null;
  const boss = new PgBoss({
    schema,
    useListenNotify: true,
    db: {
      executeSql: async (text, values) => {
        if (!pg) throw new Error("Cron queue database is closed");
        return (await pg.pool()).query(text, values);
      },
      listen: async (channel, onNotification, onReconnect) => {
        if (!pg) throw new Error("Cron queue database is closed");
        return listenForPgBoss(pg, channel, onNotification, onReconnect);
      },
    },
  });
  async function closePool() {
    const previous = pg;
    pg = null;
    await previous?.close();
  }
  boss.on("error", (e) => console.error("[cron-queue] pg-boss error:", errMessage(e)));
  let ticker: Sweeper | null = null;
  let started = false;
  let initialized = false;
  let lastSendOkAt = 0;
  return {
    async start(handlers, tickIntervalMs) {
      if (started) return;
      pg ??= createPgPool(databaseUrl, []);
      try {
        if (!initialized) {
          await boss.start();
          initialized = true;
        }
        await boss.createQueue(FIRE_QUEUE, { policy: "short", notify: true });
        await boss.createQueue(TICK_QUEUE, { policy: "short", notify: true });
        const localConcurrency = Math.min(32, Math.max(1, Math.trunc(fireConcurrency)));
        await boss.work<CronFireJob>(
          FIRE_QUEUE,
          {
            pollingIntervalSeconds: 1,
            notifyPollingIntervalSeconds: NOTIFY_POLLING_INTERVAL_SECONDS,
            batchSize: 1,
            localConcurrency,
          },
          async (jobs) => {
            for (const job of jobs) await handlers.onFire(job.data);
          },
        );
        await boss.work(
          TICK_QUEUE,
          { pollingIntervalSeconds: 1, notifyPollingIntervalSeconds: NOTIFY_POLLING_INTERVAL_SECONDS },
          () => handlers.onTick(),
        );
      } catch (e) {
        if (initialized) {
          await Promise.all([
            boss.offWork(FIRE_QUEUE, { wait: false }),
            boss.offWork(TICK_QUEUE, { wait: false }),
          ]).catch(() => {});
        } else {
          await boss.stop({ close: true, graceful: false }).catch(() => {});
          await closePool();
        }
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
        startAfter: new Date(Math.max(job.scheduledAt, job.notBefore ?? 0)),
        singletonKey: `${job.cronId}:${job.scheduledAt}`,
        retryLimit: 0,
      });
    },
    healthy() {
      return started && Date.now() - lastSendOkAt < HEALTHY_SEND_MAX_AGE_MS;
    },
    async stopClaims() {
      started = false;
      void ticker?.stop();
      await Promise.all([boss.offWork(FIRE_QUEUE, { wait: false }), boss.offWork(TICK_QUEUE, { wait: false })]);
    },
    async stop() {
      started = false;
      await ticker?.stop();
      try {
        await boss.stop({ close: true, graceful: false });
      } finally {
        initialized = false;
        await closePool();
      }
    },
  };
}
