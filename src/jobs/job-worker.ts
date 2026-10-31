import { randomUUID } from "node:crypto";
import {
  type AbsurdDb as AbsurdConnection,
  type ClaimedRun,
  cancelTask,
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
import { withPgTransaction, pgPoolMax } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { WorkAdmissionClosed } from "../util/admitted-work.ts";
import { reportFailure } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

export type JobDisposition = "done" | "release" | number;

export type JobHandler = (params: unknown) => Promise<JobDisposition>;

export interface HandleOptions {
  concurrency?: number;
  maxAttempts?: number;
}

export interface JobWorker {
  handle(name: string, handler: JobHandler, opts?: HandleOptions): void;
  spawn(name: string, params: unknown, key: string, db?: AbsurdConnection): Promise<void>;
  every(name: string, everyMs: number, fn: () => unknown, opts?: { immediate?: boolean }): void;
  start(): Promise<void>;
  healthy(): boolean;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(): Promise<void>;
}

export const JOBS_READY_CHANNEL = "qm_jobs_ready";

const UNHEALTHY_AFTER_ERROR_MS = 30_000;
const UNKNOWN_JOB_RETRY_MS = 60_000;
const BUSY_RETRY_MS = 1000;
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 5000;
const CLAIM_TIMEOUT_SEC = 120;
const CLAIM_EXTEND_MS = 30_000;
const RELEASE_RETRY_BASE_MS = 5000;
const RELEASE_RETRY_MAX_MS = 5 * 60_000;
const EVERY_PREFIX = "every:";
const LIVE_STATES = ["pending", "running", "sleeping"];

const DONE_RETENTION_SEC = 7 * 24 * 60 * 60;
const CLEANUP_BATCH = 1000;

const claimBudget = () => Math.max(1, Math.floor(pgPoolMax("query") / 2));
const clampConcurrency = (n: number) => Math.min(claimBudget(), Math.max(1, Math.trunc(n)));

export const releaseRetryAt = (attempt: number, now = Date.now()): number =>
  now + Math.min(RELEASE_RETRY_MAX_MS, RELEASE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));

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

type Db = ReturnType<typeof registerAbsurdSchema>;
type Handlers = Map<string, { run: JobHandler; concurrency: number; maxAttempts: number | null; running: number }>;

async function settleJob(db: Db, task: ClaimedRun, disposition: JobDisposition): Promise<void> {
  const pool = await db.pool();
  const { runId } = task;
  if (disposition === "done") await completeRun(pool, JOB_QUEUE, runId);
  else if (disposition === "release")
    await failRun(pool, JOB_QUEUE, runId, { message: "released unfinished" }, new Date(releaseRetryAt(task.attempt)));
  else await scheduleRun(pool, JOB_QUEUE, runId, new Date(disposition));
}

async function runJob(db: Db, handlers: Handlers, task: ClaimedRun): Promise<void> {
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
    let disposition: JobDisposition;
    if (!handler) disposition = Date.now() + UNKNOWN_JOB_RETRY_MS;
    else if (busy) disposition = Date.now() + BUSY_RETRY_MS;
    else
      disposition = await handler.run(task.params).catch((e: unknown): JobDisposition => {
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

async function runRecurring(job: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof WorkAdmissionClosed)) reportFailure(`jobs: ${job}`, e);
  }
}

async function armRecurring(db: Db, recurring: readonly string[]): Promise<void> {
  await withPgTransaction(await db.pool(), async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:jobs:every'))");
    const { rows } = await client.query<{ task_id: string; task_name: string }>(
      `SELECT task_id, task_name FROM absurd.t_jobs WHERE task_name LIKE 'every:%' AND state = ANY($1)`,
      [LIVE_STATES],
    );
    const wanted = new Set(recurring);
    const live = new Set<string>();
    for (const row of rows) {
      if (wanted.has(row.task_name)) live.add(row.task_name);
      else await cancelTask(client, JOB_QUEUE, row.task_id);
    }
    for (const job of recurring) {
      if (live.has(job)) continue;
      await spawnTask(client, JOB_QUEUE, job, null, { idempotencyKey: `${job}:${randomUUID()}`, maxAttempts: null });
    }
  });
}

export function createJobWorker(databaseUrl: string): JobWorker {
  const db = registerAbsurdSchema(databaseUrl);
  const worker = `jobs:${randomUUID()}`;
  const handlers: Handlers = new Map();
  const recurring: Array<{ job: string; immediate: boolean }> = [];
  let starts = 0;
  let started = false;
  let lastErrorAt = 0;
  let loop: Promise<void> | null = null;
  let unlisten: (() => Promise<void>) | null = null;
  let wake = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const noteError = (e: unknown): never => {
    lastErrorAt = Date.now();
    throw e;
  };

  async function poll(): Promise<void> {
    const mine = new Set<Promise<void>>();
    let idleMs = POLL_MIN_MS;
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
      if (claimed > 0) idleMs = POLL_MIN_MS;
      if (claimed === 0 || mine.size >= limit) {
        const woke = await Promise.race([
          sleep(mine.size >= limit ? POLL_MAX_MS : idleMs, { unref: true }).then(() => false),
          wake.promise.then(() => true),
        ]);
        idleMs = woke ? POLL_MIN_MS : Math.min(POLL_MAX_MS, idleMs * 2);
        wake = Promise.withResolvers<void>();
      }
    }
  }

  async function spawnKeyed(
    name: string,
    params: unknown,
    key: string,
    maxAttempts: number | null,
    conn?: AbsurdConnection,
  ): Promise<void> {
    const pool = conn ?? (await db.pool());
    const spawned = await spawnTask(pool, JOB_QUEUE, name, params, { idempotencyKey: key, maxAttempts }).catch(
      noteError,
    );
    if (!spawned.created) await retryTask(pool, JOB_QUEUE, spawned.taskId).catch(noteError);
    await pool.query("SELECT pg_notify($1, '1')", [JOBS_READY_CHANNEL]).catch(noteError);
    wake.resolve();
  }

  async function drained(): Promise<void> {
    while (active.size) await Promise.allSettled([...active]);
  }

  async function stopClaims(): Promise<void> {
    started = false;
    wake.resolve();
    await loop;
    loop = null;
    await unlisten?.();
    unlisten = null;
  }

  const jobWorker = serializeStart({
    handle(name, run, opts = {}) {
      handlers.set(name, {
        run,
        concurrency: clampConcurrency(opts.concurrency ?? claimBudget()),
        maxAttempts: opts.maxAttempts ?? 1,
        running: 0,
      });
    },
    async spawn(name, params, key, conn) {
      await spawnKeyed(name, params, key, handlers.get(name)?.maxAttempts ?? 1, conn);
    },
    every(name, everyMs, fn, opts = {}) {
      const job = `${EVERY_PREFIX}${name}`;
      recurring.push({ job, immediate: opts.immediate ?? false });
      handlers.set(job, {
        run: async (params) => {
          await runRecurring(job, fn);
          return (params as { once?: boolean } | null)?.once ? "done" : Date.now() + everyMs;
        },
        concurrency: 1,
        maxAttempts: null,
        running: 0,
      });
    },
    async start() {
      if (started) return;
      await armRecurring(
        db,
        recurring.map(({ job }) => job),
      ).catch(noteError);
      const start = `${worker}:${++starts}`;
      for (const { job, immediate } of recurring) {
        if (immediate) await spawnKeyed(job, { once: true }, `${job}:start:${start}`, 1);
      }
      unlisten = subscribePostgresChannel(
        databaseUrl,
        JOBS_READY_CHANNEL,
        () => wake.resolve(),
        () => wake.resolve(),
      );
      started = true;
      lastErrorAt = 0;
      loop = poll();
    },
    healthy() {
      return started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS;
    },
    stopClaims,
    drained,
    async stop() {
      await stopClaims();
      await drained();
    },
  });
  jobWorker.every("jobs:cleanup", 60 * 60_000, async () => {
    while ((await cleanup(await db.pool(), JOB_QUEUE, DONE_RETENTION_SEC, CLEANUP_BATCH)).tasks >= CLEANUP_BATCH);
  });
  return jobWorker;
}
