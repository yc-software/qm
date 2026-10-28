import { randomUUID } from "node:crypto";
import {
  abandonTask,
  type ClaimedRun,
  claimTasks,
  cleanup,
  completeRun,
  extendClaim,
  failRun,
  retryTask,
  scheduleRun,
  spawnTask,
} from "../turns/absurd.ts";
import { JOB_QUEUE, registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { WorkAdmissionClosed } from "../util/admitted-work.ts";
import { reportFailure } from "../util/errors.ts";
import { mapBounded, sleep } from "../util/async.ts";
import { pgPoolMax, pgTenancyEnabled, tenantLockKey } from "../persistence/pg-pool.ts";
import { holdTenant, tenant, withEveryTenant, withoutTenant, withTenant, type Tenant } from "../tenant.ts";
import { retiredTenantReason, taskTenant } from "../tenants/directory.ts";

/**
 * What became of a claimed job: `done` finished it; `release` gave it up unfinished (the next
 * spawn with the same key re-arms it); a number sleeps the job until that epoch-ms time.
 */
export type JobDisposition = "done" | "release" | number;

export type JobHandler = (params: unknown) => Promise<JobDisposition>;

export type EveryOptions = { immediate?: boolean } & ({ shared: true } | { due: string });

export const hasRows = (table: string, where = "true"): string =>
  `EXISTS (SELECT 1 FROM ${table} w WHERE w.tenant_id = t.id AND (${where}))`;

/** Background jobs on the Absurd `jobs` queue: named handlers, keyed spawns, claimed by background owners. */
export interface JobWorker {
  /** Register a handler; `concurrency` caps how many of this job run at once in this process. */
  handle(name: string, handler: JobHandler, opts?: { concurrency?: number }): void;
  /** Durably queue a job; a key already live is a no-op, a released one is re-armed. */
  spawn(name: string, params: unknown, key: string): Promise<void>;
  every(name: string, everyMs: number, fn: () => unknown, opts: EveryOptions): void;
  start(): Promise<void>;
  healthy(): boolean;
  stopClaims(): Promise<void>;
  stop(): Promise<void>;
}

const UNHEALTHY_AFTER_ERROR_MS = 30_000;
const UNKNOWN_JOB_RETRY_MS = 60_000;
const TENANT_NOT_READY_RETRY_MS = 5_000;
const BUSY_RETRY_MS = 1000;
const POLL_MS = 1000;
const CLAIM_TIMEOUT_SEC = 120;
const CLAIM_EXTEND_MS = 30_000;

const DONE_RETENTION_SEC = 7 * 24 * 60 * 60;
const CLEANUP_BATCH = 1000;
const UNDEFINED_TABLE = "42P01";

const claimBudget = () => pgPoolMax("query");
const clampConcurrency = (n: number) => Math.min(claimBudget(), Math.max(1, Math.trunc(n)));

function serializeStart(worker: JobWorker): JobWorker {
  let starting: Promise<void> | null = null;
  const { start, stopClaims, stop } = worker;
  const started = () => starting?.catch(() => {});
  return Object.assign(worker, {
    start: () => (starting ??= start().finally(() => (starting = null))),
    stopClaims: async () => (await started(), stopClaims()),
    stop: async () => (await started(), stop()),
  });
}

type AbsurdDb = ReturnType<typeof registerAbsurdSchema>;
type Settlement = JobDisposition | { abandon: string };
type JobHandlers = Map<
  string,
  {
    run: (params: unknown, tenantId: string | undefined) => Promise<Settlement>;
    concurrency: number;
    running: number;
  }
>;

async function settleJob(db: AbsurdDb, task: ClaimedRun, disposition: Settlement): Promise<void> {
  const pool = await db.pool();
  const { runId } = task;
  if (typeof disposition === "object") await abandonTask(pool, JOB_QUEUE, task, disposition.abandon);
  else if (disposition === "done") await completeRun(pool, JOB_QUEUE, runId);
  else if (disposition === "release") await failRun(pool, JOB_QUEUE, runId, { message: "released unfinished" });
  else await scheduleRun(pool, JOB_QUEUE, runId, new Date(disposition));
}

async function runJob(db: AbsurdDb, handlers: JobHandlers, task: ClaimedRun): Promise<void> {
  const { taskName: name, runId } = task;
  const keepAlive = setInterval(() => {
    void db
      .pool()
      .then((pool) => extendClaim(pool, JOB_QUEUE, runId, CLAIM_TIMEOUT_SEC))
      .catch((e: unknown) => reportFailure("jobs: extend claim", e, `job=${name}`));
  }, CLAIM_EXTEND_MS);
  keepAlive.unref?.();
  const handler = handlers.get(name);
  const busy = handler && handler.running >= handler.concurrency;
  if (handler && !busy) handler.running++;
  try {
    let disposition: Settlement;
    if (!handler) disposition = Date.now() + UNKNOWN_JOB_RETRY_MS;
    else if (busy) disposition = Date.now() + BUSY_RETRY_MS;
    else
      disposition = await handler.run(task.params, task.tenantId).catch((e: unknown): Settlement => {
        reportFailure("jobs: run", e, `job=${name}`);
        return "release";
      });
    await settleJob(db, task, disposition);
  } catch (e) {
    reportFailure("jobs: settle", e, `job=${name}`);
  } finally {
    if (handler && !busy) handler.running--;
    clearInterval(keepAlive);
  }
}

async function runRecurring(job: string, fn: () => unknown, context?: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof WorkAdmissionClosed)) reportFailure(`jobs: ${job}`, e, context);
  }
}

async function dueTenants(db: AbsurdDb, job: string, due: string): Promise<Tenant[]> {
  if (!pgTenancyEnabled()) return [tenant()];
  const rows = await withEveryTenant(async () =>
    (await db.pool()).query(
      `SELECT t.id::text AS id FROM (SELECT id FROM qm_tenant UNION SELECT id FROM tenants WHERE status = 'active') t
        WHERE ${due}`,
    ),
  ).catch((e: unknown) => {
    if ((e as { code?: string }).code === UNDEFINED_TABLE) return { rows: [] };
    throw e;
  });
  const owners = await mapBounded(rows.rows as Array<{ id: string }>, claimBudget(), ({ id }) =>
    taskTenant(id, true).catch((e: unknown) => {
      reportFailure(`jobs: ${job} tenant`, e, `tenant=${id}`);
      return undefined;
    }),
  );
  return owners.filter((owner): owner is Tenant => typeof owner === "object");
}

export function createJobWorker(databaseUrl: string): JobWorker {
  const db = registerAbsurdSchema(databaseUrl);
  const worker = `jobs:${randomUUID()}`;
  const handlers: JobHandlers = new Map();
  const recurring: Array<{ job: string; immediate: boolean }> = [];
  let starts = 0;
  let started = false;
  let lastErrorAt = 0;
  let loop: Promise<void> | null = null;
  let wake = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const noteError = (e: unknown): never => {
    lastErrorAt = Date.now();
    throw e;
  };

  async function poll(): Promise<void> {
    const mine = new Set<Promise<void>>();
    while (started) {
      const limit = claimBudget();
      const free = limit - mine.size;
      let claimed = 0;
      if (free > 0) {
        try {
          for (const task of await claimTasks(await db.pool(), JOB_QUEUE, worker, CLAIM_TIMEOUT_SEC, free)) {
            claimed++;
            const work = runJob(db, handlers, task);
            active.add(work);
            mine.add(work);
            void work.finally(() => {
              active.delete(work);
              mine.delete(work);
              wake.resolve();
            });
          }
        } catch (e) {
          lastErrorAt = Date.now();
          reportFailure("jobs: claim", e);
        }
      }
      if (claimed === 0 || mine.size >= limit) {
        await Promise.race([sleep(POLL_MS, { unref: true }), wake.promise]);
        wake = Promise.withResolvers<void>();
      }
    }
  }

  /** Spawn or re-arm the job keyed `key`; true when this created it. */
  async function spawnKeyed(name: string, params: unknown, key: string, maxAttempts: number | null): Promise<boolean> {
    const pool = await db.pool();
    const spawned = await spawnTask(pool, JOB_QUEUE, name, params, { idempotencyKey: key, maxAttempts }).catch(
      noteError,
    );
    if (!spawned.created) await retryTask(pool, JOB_QUEUE, spawned.taskId).catch(noteError);
    wake.resolve();
    return spawned.created;
  }

  async function stopClaims(): Promise<void> {
    started = false;
    wake.resolve();
    await loop;
    loop = null;
  }

  const jobWorker = serializeStart({
    handle(name, run, opts = {}) {
      handlers.set(name, {
        run: async (params, tenantId) => {
          const owner = await taskTenant(tenantId).catch((e: unknown) => {
            reportFailure(`jobs: ${name} tenant`, e);
            return undefined;
          });
          if (owner === "retired") return { abandon: retiredTenantReason(tenantId) };
          if (!owner) return Date.now() + TENANT_NOT_READY_RETRY_MS;
          const release = holdTenant(owner);
          return withTenant(owner, () => run(params)).finally(release);
        },
        concurrency: clampConcurrency(opts.concurrency ?? claimBudget()),
        running: 0,
      });
    },
    async spawn(name, params, key) {
      await spawnKeyed(name, params, tenantLockKey(key), 1);
    },
    every(name, everyMs, fn, opts) {
      const job = `every:${name}`;
      recurring.push({ job, immediate: opts.immediate ?? false });
      handlers.set(job, {
        run: async (params) => {
          if ("shared" in opts) await runRecurring(job, () => withEveryTenant(fn));
          else {
            const owners = await dueTenants(db, job, opts.due).catch((e: unknown) => {
              reportFailure(`jobs: ${job} tenants`, e);
              return [];
            });
            await mapBounded(owners, claimBudget(), async (owner) => {
              const release = holdTenant(owner);
              await runRecurring(job, () => withTenant(owner, fn), `tenant=${owner.slug ?? "home"}`).finally(release);
            });
          }
          return (params as { once?: boolean } | null)?.once ? "done" : Date.now() + everyMs;
        },
        concurrency: 1,
        running: 0,
      });
    },
    async start() {
      if (started) return;
      const pool = await db.pool();
      await pool.query("SELECT 1").catch(noteError);
      const start = `${worker}:${++starts}`;
      await withoutTenant(async () => {
        for (const { job, immediate } of recurring) {
          const created = await spawnKeyed(job, null, job, null);
          if (immediate && !created) await spawnKeyed(job, { once: true }, `${job}:start:${start}`, 1);
        }
      });
      started = true;
      lastErrorAt = 0;
      loop = withoutTenant(() => poll());
    },
    healthy() {
      return started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS;
    },
    stopClaims,
    async stop() {
      await stopClaims();
      while (active.size) await Promise.allSettled([...active]);
    },
  });
  // Finished and failed jobs (spent cron slots, webhook fires, start-up runs) are dropped after a week.
  jobWorker.every(
    "jobs:cleanup",
    60 * 60_000,
    async () => {
      while ((await cleanup(await db.pool(), JOB_QUEUE, DONE_RETENTION_SEC, CLEANUP_BATCH)).tasks >= CLEANUP_BATCH);
    },
    { shared: true },
  );
  return jobWorker;
}
