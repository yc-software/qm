import { PgBoss } from "pg-boss";
import pgBossPackage from "pg-boss/package.json" with { type: "json" };
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export interface CronFireJob {
  tenantId: string;
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

export function fireJobStartsAt(job: CronFireJob): number {
  return Math.max(job.scheduledAt, job.notBefore ?? 0);
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
const FIRE_QUEUE_OPTIONS = { policy: "short", notify: true } as const;

export async function installCronQueue(databaseUrl: string, schema: string = "pgboss"): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid cron queue schema: ${schema}`);
  const pg = createPgPool(databaseUrl);
  const boss = new PgBoss({
    schema,
    supervise: false,
    schedule: false,
    db: { executeSql: async (text, values) => (await pg.pool()).query(text, values) },
  });
  try {
    await boss.start();
    await boss.createQueue(FIRE_QUEUE, FIRE_QUEUE_OPTIONS);
  } finally {
    await boss.stop({ close: true, graceful: false }).catch(swallowAs("cron queue install: cleanup", undefined));
    await pg.close().catch(swallowAs("cron queue install: cleanup", undefined));
  }
}

class CronQueueNotInstalled extends Error {}

async function assertInstalled(boss: PgBoss, schema: string): Promise<void> {
  const installed = (await boss.isInstalled()) ? await boss.schemaVersion() : null;
  if (installed !== pgBossPackage.pgboss.schema)
    throw new CronQueueNotInstalled(
      `cron queue schema ${schema} is at version ${installed ?? "none"}, expected ${pgBossPackage.pgboss.schema}`,
    );
}

export function cronQueueMisconfigured(error: unknown): boolean {
  return error instanceof CronQueueNotInstalled || (error as { code?: unknown } | null)?.code === "42501";
}

export function createPgBossCronQueue(
  databaseUrl: string,
  schema: string = "pgboss",
  fireConcurrency: number = 1,
): CronJobQueue {
  let pg: PgPool | null = null;
  const boss = new PgBoss({
    schema,
    migrate: false,
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
      pg ??= createPgPool(databaseUrl);
      try {
        if (!initialized) {
          await assertInstalled(boss, schema);
          await boss.start();
          initialized = true;
        }
        await boss.createQueue(FIRE_QUEUE, FIRE_QUEUE_OPTIONS);
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
          startAfter: new Date(fireJobStartsAt(job)),
          singletonKey: `${job.tenantId}:${job.cronId}:${job.scheduledAt}`,
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
