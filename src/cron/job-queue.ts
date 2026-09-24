import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool, type PoolClient } from "../persistence/pg-pool.ts";
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
          await boss
            .offWork(FIRE_QUEUE, { wait: false })
            .catch(swallowAs("cron queue: stop worker after failed start", undefined));
        } else {
          await boss
            .stop({ close: true, graceful: false })
            .catch(swallowAs("cron queue: stop after failed start", undefined));
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
