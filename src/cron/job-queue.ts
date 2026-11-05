import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export interface CronFireJob {
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

function grantLikePublic(schema: string): string {
  return `DO $grant$
DECLARE
  grantee text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${schema}' AND pg_has_role(nspowner, 'USAGE')) THEN
    RETURN;
  END IF;
  FOR grantee IN
    SELECT DISTINCT r.rolname FROM pg_namespace n, aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public' AND a.privilege_type = 'USAGE' AND a.grantee <> n.nspowner AND NOT r.rolsuper
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', '${schema}', grantee);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', '${schema}', grantee);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', '${schema}', grantee);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', '${schema}', grantee);
  END LOOP;
END $grant$`;
}

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
    await pg.q(grantLikePublic(schema));
  } finally {
    await boss.stop({ close: true, graceful: false });
    await pg.close();
  }
}

export function cronQueueMisconfigured(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42501" || /pg-boss (is not installed|database requires migrations)/.test(errMessage(error));
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
