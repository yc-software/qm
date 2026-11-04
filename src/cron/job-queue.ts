import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export interface CronFireJob {
  tenantId?: string;
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

async function ownsCronSchema(pg: PgPool, schema: string): Promise<boolean> {
  const { rows } = await (
    await pg.pool()
  ).query(
    `SELECT n.oid IS NULL OR pg_has_role(current_user, n.nspowner, 'USAGE') AS owner
       FROM (SELECT 1) one LEFT JOIN pg_namespace n ON n.nspname = $1`,
    [schema],
  );
  return rows[0]?.owner === true;
}

function createBoss(getPg: () => PgPool | null, schema: string, migrate: boolean): PgBoss {
  return new PgBoss({
    schema,
    migrate,
    db: {
      executeSql: async (text, values) => {
        const pg = getPg();
        if (!pg) throw new Error("Cron queue database is closed");
        return (await pg.pool()).query(text, values);
      },
    },
  });
}

export async function migrateCronQueue(databaseUrl: string, schema: string = "pgboss"): Promise<void> {
  const pg = createPgPool(databaseUrl);
  const boss = createBoss(() => pg, schema, true);
  boss.on("error", (e) => console.error("[cron-queue] pg-boss migrate error:", errMessage(e)));
  try {
    await boss.start();
    await boss.createQueue(FIRE_QUEUE, { policy: "short", notify: true });
  } finally {
    await boss.stop({ close: true, graceful: false }).catch(swallowAs("cron queue: stop after migrate", undefined));
    await pg.close();
  }
}

export function createPgBossCronQueue(
  databaseUrl: string,
  schema: string = "pgboss",
  fireConcurrency: number = 1,
): CronJobQueue {
  let pg: PgPool | null = null;
  let boss: PgBoss | null = null;
  async function closePool() {
    const previous = pg;
    pg = null;
    await previous?.close();
  }
  let started = false;
  let lastErrorAt = 0;
  async function startBoss(db: PgPool): Promise<PgBoss> {
    if (boss) return boss;
    const owner = await ownsCronSchema(db, schema);
    const created = createBoss(() => pg, schema, owner);
    created.on("error", (e) => {
      lastErrorAt = Date.now();
      console.error("[cron-queue] pg-boss error:", errMessage(e));
    });
    try {
      await created.start();
    } catch (e) {
      await created
        .stop({ close: true, graceful: false })
        .catch(swallowAs("cron queue: stop after failed start", undefined));
      throw e;
    }
    boss = created;
    if (owner) await created.createQueue(FIRE_QUEUE, { policy: "short", notify: true });
    else if (!(await created.getQueue(FIRE_QUEUE))) {
      throw new Error("The cron queue is not installed; run migrations as the database owner");
    }
    return created;
  }
  return {
    async start(handlers) {
      if (started) return;
      pg ??= createPgPool(databaseUrl);
      try {
        const active = await startBoss(pg);
        const localConcurrency = Math.min(32, Math.max(1, Math.trunc(fireConcurrency)));
        await active.work<CronFireJob>(
          FIRE_QUEUE,
          { pollingIntervalSeconds: 1, batchSize: 1, localConcurrency },
          async (jobs) => {
            for (const job of jobs) await handlers.onFire(job.data);
          },
        );
      } catch (e) {
        if (boss) {
          await boss
            .offWork(FIRE_QUEUE, { wait: false })
            .catch(swallowAs("cron queue: stop worker after failed start", undefined));
        } else {
          await closePool();
        }
        throw e;
      }
      started = true;
      lastErrorAt = 0;
    },
    async enqueueFire(job) {
      if (!started || !boss) return;
      await boss
        .send(FIRE_QUEUE, job, {
          startAfter: new Date(fireJobStartsAt(job)),
          singletonKey: `${job.tenantId === undefined ? "" : `${job.tenantId}:`}${job.cronId}:${job.scheduledAt}`,
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
      await boss?.offWork(FIRE_QUEUE, { wait: false });
    },
    async stop() {
      started = false;
      try {
        await boss?.stop({ close: true, graceful: false });
      } finally {
        boss = null;
        await closePool();
      }
    },
  };
}
