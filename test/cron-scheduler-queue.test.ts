import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createScheduler, CRON_FIRE_JOB, type Scheduler } from "../src/cron/scheduler.ts";
import { createJobWorker, type JobWorker } from "../src/jobs/job-worker.ts";
import { createCronStore, type CronStore } from "../src/cron/cron-store.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";

const URL = testDatabaseUrl();
const crons = createCronStore(testMap(), { fires: createPostgresCronFireStore(URL) });
const idempotency = createIdempotencyStore(testMap());
const identity = createIdentityService(testMap(), { externalMembers: testMap() });
const advisoryLock = testAdvisoryLock();

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function instance(calls: TurnRequest[], turnMs = 0): { scheduler: Scheduler; crons: CronStore; jobs: JobWorker } {
  const jobs = createJobWorker(URL);
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (turnMs) await new Promise((r) => setTimeout(r, turnMs));
    return { status: "ok", reply: "QUEUE-OUTPUT" };
  };
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    advisoryLock,
    crons,
    deliveries: createDeliveryStore(),
    idempotency,
    identity,
    run,
    jobs,
    fireConcurrency: 4,
  });
  return { scheduler, crons, jobs };
}

async function jobRows(where = "true"): Promise<Array<{ task_name: string; state: string; params: unknown }>> {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    return (await client.query(`SELECT task_name, state, params FROM absurd.t_jobs WHERE ${where}`)).rows;
  } finally {
    await client.end();
  }
}

test("a manual fire queued by a process that dies before running it is run by the next worker", async () => {
  const calls: TurnRequest[] = [];
  const dying = instance(calls);
  const cron = await crons.create({
    schedule: { everyMs: 60 * 60_000 },
    action: "run me now",
    owner: "U4",
    createdBy: "U4",
    ownerScopeId: scopeId("personal", "U4"),
  });
  const started = await dying.scheduler.runNow(cron.id);
  assert.ok(started.started, "the fire is accepted before any worker claims it");
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "running");
  const refused = await dying.scheduler.runNow(cron.id);
  assert.equal(refused.started ? "" : refused.reason, "already_running");
  assert.equal(calls.length, 0, "nothing ran in the process that queued the fire");

  const survivor = instance(calls);
  await survivor.jobs.start();
  try {
    await until(() => calls.length >= 1, 30_000);
    await until(async () => (await crons.listFires(cron.id)).runs[0]?.status === "ok", 10_000);
    assert.equal(calls.length, 1, "the queued manual fire runs exactly once");
    assert.equal(calls[0]?.idempotencyKey, started.fireKey);
    const { runs } = await crons.listFires(cron.id);
    assert.deepEqual(
      runs.map((r) => [r.fireKey, r.status]),
      [[started.fireKey, "ok"]],
    );
  } finally {
    await survivor.jobs.stop();
  }
});

test("a recurring cron chains fires across two workers without firing any slot twice", async () => {
  const calls: TurnRequest[] = [];
  const a = instance(calls);
  const b = instance(calls);
  await a.jobs.start();
  await b.jobs.start();
  try {
    const cron = await crons.create({
      schedule: { everyMs: 1500 },
      action: "poll the queue",
      owner: "U2",
      createdBy: "U2",
      ownerScopeId: scopeId("personal", "U2"),
    });
    a.scheduler.notifyChanged(cron.id);
    const fires = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`));
    await until(() => fires().length >= 3, 45_000);
    assert.ok(fires().length >= 3, "fire jobs chain");
    const keys = fires().map((c) => c.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length, "no slot fires twice");
    await crons.update(cron.id, { schedule: { everyMs: 60 * 60_000 } });
    b.scheduler.notifyChanged(cron.id);
    await new Promise((r) => setTimeout(r, 2_000));
    const at = fires().length;
    await new Promise((r) => setTimeout(r, 4_000));
    assert.equal(fires().length, at, "a rescheduled cron's stale slot jobs do not fire");
  } finally {
    await Promise.all([a.jobs.stop(), b.jobs.stop()]);
  }
});

test("repair re-arms an enabled cron that has no fire job, exactly once across workers", async () => {
  const calls: TurnRequest[] = [];
  const a = instance(calls);
  const b = instance(calls);
  const cron = await crons.create({
    schedule: { firstFireAt: Date.now() - 1000 },
    action: "survive the cutover",
    owner: "U3",
    createdBy: "U3",
    ownerScopeId: scopeId("personal", "U3"),
  });
  await Promise.all([a.jobs.start(), b.jobs.start()]);
  try {
    const fired = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
    await until(() => fired() >= 1, 30_000);
    await Promise.all([a.scheduler.repair(), b.scheduler.repair()]);
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(fired(), 1, "the boot-time repair job fires the orphaned slot once");
    assert.equal((await crons.listFires(cron.id)).total, 1);
  } finally {
    await Promise.all([a.jobs.stop(), b.jobs.stop()]);
  }
});

test("a released job is re-armed by the next spawn of its key; a finished one is not", async () => {
  const jobs = createJobWorker(URL);
  const seen: string[] = [];
  let outcome: "release" | "done" = "release";
  jobs.handle("test-rearm", async (params) => {
    seen.push((params as { n: string }).n);
    return outcome;
  });
  await jobs.start();
  try {
    await jobs.spawn("test-rearm", { n: "a" }, "rearm-key");
    await until(() => seen.length >= 1, 10_000);
    await until(async () => (await jobRows("task_name = 'test-rearm'"))[0]?.state === "failed", 10_000);
    outcome = "done";
    await jobs.spawn("test-rearm", { n: "b" }, "rearm-key");
    await until(() => seen.length >= 2, 10_000);
    assert.deepEqual(seen, ["a", "a"], "the re-armed task keeps its original params");
    await until(async () => (await jobRows("task_name = 'test-rearm'"))[0]?.state === "completed", 10_000);
    await jobs.spawn("test-rearm", { n: "c" }, "rearm-key");
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(seen.length, 2, "a completed key is not re-run");
  } finally {
    await jobs.stop();
  }
});

test("stopping claims leaves an in-flight job running and a restart claims new work", async () => {
  const jobs = createJobWorker(URL);
  const oldEntered = Promise.withResolvers<void>();
  const oldFinish = Promise.withResolvers<void>();
  const newEntered = Promise.withResolvers<void>();
  let oldFinished = false;
  jobs.handle("test-handover", async (params) => {
    if ((params as { which: string }).which === "old") {
      oldEntered.resolve();
      await oldFinish.promise;
      oldFinished = true;
    } else newEntered.resolve();
    return "done";
  });
  try {
    await jobs.start();
    await jobs.spawn("test-handover", { which: "old" }, "handover-old");
    await oldEntered.promise;
    await jobs.stopClaims();
    assert.equal(oldFinished, false);
    await jobs.start();
    await jobs.spawn("test-handover", { which: "new" }, "handover-new");
    await newEntered.promise;
    assert.equal(oldFinished, false);
    oldFinish.resolve();
    await jobs.drained();
    assert.equal(oldFinished, true);
  } finally {
    oldFinish.resolve();
    await jobs.stop();
  }
});

test("every-jobs are armed once across workers, retired ones are cancelled, and a cancelled one is re-armed", async () => {
  const ticks: string[] = [];
  const a = createJobWorker(URL);
  const b = createJobWorker(URL);
  a.every("test:alive", 60_000, () => void ticks.push("a"), { immediate: true });
  b.every("test:alive", 60_000, () => void ticks.push("b"));
  b.every("test:retired-later", 60_000, () => {});
  try {
    await b.start();
    await b.stopClaims();
    await a.start();
    const live = async (name: string) =>
      (await jobRows(`task_name = '${name}' AND state IN ('pending', 'running', 'sleeping')`)).length;
    assert.equal(await live("every:test:alive"), 1, "one recurring task however many workers start");
    assert.equal(await live("every:test:retired-later"), 0, "a worker without the job cancels its task");
    await until(() => ticks.length >= 1, 10_000);
    await a.stopClaims();
    await b.start();
    assert.equal(
      await live("every:test:retired-later"),
      1,
      "a cancelled every-job is re-armed by a worker that has it",
    );
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});

test("a spawn inside a rolled-back transaction leaves no job", async () => {
  const jobs = createJobWorker(URL);
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await jobs.start();
    await client.query("BEGIN");
    await jobs.spawn("test-rollback", { cronId: "x" }, "rollback-key", client as never);
    await client.query("ROLLBACK");
    assert.equal((await jobRows("task_name = 'test-rollback'")).length, 0);
  } finally {
    await client.end();
    await jobs.stop();
  }
});

test("job params hold ids only: no prompts, payloads or other user content", async () => {
  const allowed = new Set([
    "cronId",
    "scheduledAt",
    "fireKey",
    "firedAt",
    "webhookId",
    "deliveryId",
    "loopId",
    "sourceId",
    "once",
    "which",
    "n",
  ]);
  const rows = await jobRows();
  assert.ok(rows.some((row) => row.task_name === CRON_FIRE_JOB));
  for (const row of rows) {
    if (row.params === null) continue;
    for (const [key, value] of Object.entries(row.params as Record<string, unknown>)) {
      assert.ok(allowed.has(key), `${row.task_name} carries ${key}`);
      assert.ok(typeof value !== "object" || value === null, `${row.task_name}.${key} is a scalar`);
    }
  }
});
