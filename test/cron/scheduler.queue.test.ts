import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScheduler,
  CRON_FIRE_JOB,
  CRON_MANUAL_FIRE_JOB,
  type Scheduler,
  type CronFireJob,
} from "../../src/cron/scheduler.ts";
import { createJobWorker, type JobWorker } from "../../src/jobs/job-worker.ts";
import { createCronStore, type CronStore } from "../../src/cron/cron-store.ts";
import { type CronFireStore, createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { testDatabaseUrl, testAdvisoryLock } from "../support/test-database.ts";
import { settle } from "../support/settle.ts";
import { busyOnce, schedulerDeps } from "../support/cron-scheduler-harness.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron queue tests";

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function instance(
  calls: TurnRequest[],
  turnMs: number,
  fires: CronFireStore,
): { scheduler: Scheduler; crons: CronStore; jobs: JobWorker } {
  const crons = createCronStore(URL!, { fires });
  const jobs = createJobWorker(URL ?? "");
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (turnMs) await new Promise((r) => setTimeout(r, turnMs));
    return { status: "ok", reply: "QUEUE-OUTPUT" };
  };
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    crons,
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(URL!),
    identity: createIdentityService(testDatabaseUrl()),
    run,
    jobs,
    fireConcurrency: 4,
  });
  return { scheduler, crons, jobs };
}

test(
  "cron job queue: a slow fire is not double-run by a sibling instance (durable slot claim)",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fires = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 12_000, fires);
    const b = instance(calls, 12_000, fires);
    await a.jobs.start();
    await b.jobs.start();
    try {
      const cron = await a.crons.create({
        schedule: { firstFireAt: Date.now() + 500 },
        action: "remind me once",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      });
      a.scheduler.notifyChanged(cron.id);
      await until(() => calls.length >= 1, 30_000);
      assert.equal(calls.length, 1, "the due slot starts exactly one turn");
      await new Promise((r) => setTimeout(r, 16_000));
      assert.equal(calls.length, 1, "no sibling or reconcile re-run while (or after) the slow turn runs");
      assert.equal((await b.crons.get(cron.id))?.enabled, false, "the one-shot ends disabled");
      assert.equal((await b.crons.listFires(cron.id)).total, 1, "one fire recorded");
    } finally {
      await Promise.all([a.jobs.stop(), b.jobs.stop()]);
    }
  },
);

test(
  "cron job queue: a recurring cron chains fires with unique slots, and a schedule edit invalidates queued slots",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fireStore = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 0, fireStore);
    const b = instance(calls, 0, fireStore);
    await a.jobs.start();
    await b.jobs.start();
    try {
      const cron = await a.crons.create({
        schedule: { everyMs: 2000 },
        action: "poll the queue",
        owner: "U2",
        createdBy: "U2",
        ownerScopeId: scopeId("personal", "U2"),
      });
      a.scheduler.notifyChanged(cron.id);
      const fires = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fires() >= 3, 45_000);
      assert.ok(fires() >= 3, "a recurring cron chains fire jobs across instances");
      const keys = calls.map((c) => c.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, "no slot fires twice");

      await b.crons.update(cron.id, { schedule: { everyMs: 60_000 } });
      b.scheduler.notifyChanged(cron.id);
      const at = fires();
      await new Promise((r) => setTimeout(r, 6_000));
      assert.equal(fires(), at, "a rescheduled cron's stale slot jobs do not fire");
    } finally {
      await Promise.all([a.jobs.stop(), b.jobs.stop()]);
    }
  },
);

test(
  "cron job queue: a manual fire queued by a process that dies before running it is run by the next worker",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fires = createPostgresCronFireStore(testDatabaseUrl());
    const dying = instance(calls, 0, fires);
    const cron = await dying.crons.create({
      schedule: { everyMs: 60 * 60_000 },
      action: "run me now",
      owner: "U4",
      createdBy: "U4",
      ownerScopeId: scopeId("personal", "U4"),
    });
    const started = await dying.scheduler.runNow(cron.id);
    assert.ok(started.started, "the fire is accepted before any worker claims it");
    assert.equal((await dying.crons.listFires(cron.id)).runs[0]?.status, "running");
    assert.equal(calls.length, 0, "nothing ran in the process that queued the fire");

    const survivor = instance(calls, 0, fires);
    await survivor.jobs.start();
    try {
      await until(() => calls.length >= 1, 30_000);
      await new Promise((r) => setTimeout(r, 2_000));
      assert.equal(calls.length, 1, "the queued manual fire runs exactly once");
      assert.equal(calls[0]?.idempotencyKey, started.fireKey);
      const { runs } = await survivor.crons.listFires(cron.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.fireKey, started.fireKey);
      assert.equal(runs[0]?.status, "ok");
      const again = await survivor.scheduler.runNow(cron.id);
      assert.ok(again.started, "a finished fire no longer blocks manual runs");
      await again.settled;
      assert.equal(calls.length, 2);
    } finally {
      await survivor.jobs.stop();
    }
  },
);

test(
  "cron job queue: a cron persisted without its fire job is enqueued once by repair",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fires = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 0, fires);
    const b = instance(calls, 0, fires);
    const cron = await a.crons.create({
      schedule: { firstFireAt: Date.now() - 1000 },
      action: "survive the crash",
      owner: "U3",
      createdBy: "U3",
      ownerScopeId: scopeId("personal", "U3"),
    });
    await a.jobs.start();
    await b.jobs.start();
    try {
      await Promise.all([a.scheduler.repair(), b.scheduler.repair()]);
      const fired = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fired() >= 1, 30_000);
      await new Promise((r) => setTimeout(r, 3_000));
      assert.equal(fired(), 1, "the orphaned slot fires exactly once across both instances");
      assert.equal((await a.crons.listFires(cron.id)).total, 1);
    } finally {
      await Promise.all([a.jobs.stop(), b.jobs.stop()]);
    }
  },
);

test(
  "job worker: a released slot is re-armed by the next enqueue, a consumed one is not",
  { skip, timeout: 60_000 },
  async () => {
    const queue = createJobWorker(URL!);
    const seen: number[] = [];
    const key = `cron:rearm-${Date.now()}`;
    const job = { cronId: key };
    queue.handle(CRON_FIRE_JOB, async () => {
      seen.push(Date.now());
      return seen.length === 1 ? "release" : "done";
    });
    await queue.start();
    try {
      await queue.spawn(CRON_FIRE_JOB, job, key);
      await until(() => seen.length >= 1, 15_000);
      await new Promise((r) => setTimeout(r, 300));
      await queue.spawn(CRON_FIRE_JOB, job, key);
      await until(() => seen.length >= 2, 15_000);
      assert.equal(seen.length, 2, "the released slot fired again");
      await new Promise((r) => setTimeout(r, 300));
      await queue.spawn(CRON_FIRE_JOB, job, key);
      await new Promise((r) => setTimeout(r, 2_500));
      assert.equal(seen.length, 2, "a consumed slot never fires twice");
    } finally {
      await queue.stop();
    }
  },
);

test(
  "job worker: an every job runs on one of two workers and keeps its cadence after a throw",
  { skip, timeout: 60_000 },
  async () => {
    const name = `cadence-${Date.now()}`;
    const runs: number[] = [];
    const workers = [createJobWorker(URL!), createJobWorker(URL!)];
    for (const worker of workers)
      worker.every(
        name,
        1000,
        () => {
          runs.push(Date.now());
          if (runs.length === 1) throw new Error("first run fails");
        },
        { due: "true" },
      );
    try {
      await Promise.all(workers.map((worker) => worker.start()));
      await until(() => runs.length >= 3, 20_000);
      assert.ok(runs.length >= 3, "the job reschedules itself, even after a failed run");
      for (let i = 1; i < runs.length; i++)
        assert.ok(runs[i]! - runs[i - 1]! >= 900, "runs never overlap or double up");
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  },
);

test(
  "job worker: an immediate every job also runs once per worker start, outside its cadence",
  { skip, timeout: 60_000 },
  async () => {
    const name = `immediate-${Date.now()}`;
    let runs = 0;
    const worker = createJobWorker(URL!);
    worker.every(name, 60 * 60_000, () => void runs++, { immediate: true, due: "true" });
    try {
      await worker.start();
      await until(() => runs >= 1, 15_000);
      await worker.stopClaims();
      await worker.start();
      await until(() => runs >= 2, 15_000);
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(runs, 2, "one run for the first spawn, one for the restart; the hourly cadence waits");
    } finally {
      await worker.stop();
    }
  },
);

test("queue mode: fires claim the slot before running, and stale or lost claims never run", async () => {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const calls: TurnRequest[] = [];
  let onFire: ((job: { cronId: string; scheduledAt: number }) => Promise<unknown>) | undefined;
  const enqueued: Array<{ cronId: string; scheduledAt: number }> = [];
  const scheduler = createScheduler({
    ...schedulerDeps(crons, databaseUrl),
    run: async (req) => {
      calls.push(req);
      return { status: "ok", reply: "OUT" };
    },
    jobs: {
      handle(name, run) {
        if (name === CRON_FIRE_JOB) onFire = run;
      },
      async spawn(_name, job) {
        enqueued.push(job as CronFireJob);
      },
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await settle(async () => onFire !== undefined);
  assert.ok(onFire, "queue mode registers the fire handler");
  scheduler.notifyChanged(cron.id);
  await settle(async () => enqueued.length > 0);
  assert.deepEqual(enqueued.pop(), { cronId: cron.id, scheduledAt: 1 }, "notifyChanged prompt-schedules the slot");

  await onFire!({ cronId: cron.id, scheduledAt: 1 });
  assert.equal(calls.length, 1, "the job for the due slot fires");
  assert.ok((await crons.get(cron.id))!.lastFiredAt, "the claim advanced the schedule");
  assert.deepEqual(enqueued.pop()?.cronId, cron.id, "the next slot is chained");

  await onFire!({ cronId: cron.id, scheduledAt: 1 });
  assert.equal(calls.length, 1, "a duplicate job for a claimed slot does not run the turn");
});

for (const queued of [false, true]) {
  test(`${queued ? "queue" : "interval"} mode: a busy cron defers without blocking other crons or losing its slot`, async () => {
    const databaseUrl = testDatabaseUrl();
    const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
    const gate = Promise.withResolvers<TurnResult>();
    const started = Promise.withResolvers<void>();
    const calls: TurnRequest[] = [];
    const enqueued: CronFireJob[] = [];
    let clock = 1000;
    let onFire: ((job: CronFireJob) => Promise<unknown>) | undefined;
    let onManualFire: ((job: unknown) => Promise<unknown>) | undefined;
    const jobs: Pick<JobWorker, "handle" | "spawn"> = {
      handle(name, run) {
        if (name === CRON_FIRE_JOB) onFire = run;
        if (name === CRON_MANUAL_FIRE_JOB) onManualFire = run;
      },
      async spawn(name, job) {
        if (name === CRON_MANUAL_FIRE_JOB) void onManualFire!(job);
        else enqueued.push(job as CronFireJob);
      },
    };
    const scheduler = createScheduler({
      ...schedulerDeps(crons, databaseUrl),
      advisoryLock: testAdvisoryLock(),
      now: () => clock,
      jobs,
      run: async (req) => {
        calls.push(req);
        if (calls.length === 1) {
          started.resolve();
          return gate.promise;
        }
        return { status: "ok", reply: "done" };
      },
    });
    const cron = await crons.create({
      schedule: { everyMs: 1000, firstFireAt: 1000 },
      action: "slow recurring job",
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
    });
    let first: Promise<unknown>;
    if (queued) first = onFire!({ cronId: cron.id, scheduledAt: 1000 });
    else {
      const manual = await scheduler.runNow(cron.id);
      assert.ok(manual.started);
      first = manual.settled;
    }
    await started.promise;
    clock = 2000;
    const other = await crons.create({
      schedule: { firstFireAt: clock },
      message: "unrelated reminder",
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
    });
    const owedSlot = (await crons.get(cron.id))!.nextFireAt!;
    let deferred = false;
    let disposition: unknown;
    const second = (queued ? onFire!({ cronId: cron.id, scheduledAt: owedSlot }) : scheduler.tick(clock)).then(
      (value) => {
        disposition = value;
        deferred = true;
      },
    );
    try {
      await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      assert.equal(deferred, true, "an active fire must not make the scheduler wait for its lifecycle lock");
      assert.equal(calls.length, 1, "the busy cron did not start another agent");
      const pending = (await crons.get(cron.id))!;
      assert.equal(pending.nextFireAt, owedSlot, "the unstarted slot remains owed");
      assert.equal(pending.deferUntil, 32_000, "the retry is durable and delayed");
      if (queued) {
        assert.equal(disposition, 32_000, "the job sleeps until the deferral");
        await onFire!({ cronId: other.id, scheduledAt: 2000 });
      }
      assert.equal((await crons.get(other.id))!.enabled, false, "an unrelated cron can finish while this one runs");
      gate.resolve({ status: "ok", reply: "done" });
      await first;
      clock = 32_000;
      if (queued) await onFire!({ cronId: cron.id, scheduledAt: owedSlot });
      else await scheduler.tick(clock);
      assert.equal(calls.length, 2, "the deferred slot runs once after the active fire completes");
      assert.equal((await crons.listFires(cron.id)).total, 2, "no phantom running fire was created for the deferral");
    } finally {
      gate.resolve({ status: "ok", reply: "done" });
      await Promise.all([first, second]);
    }
  });
}

test("queue mode: concurrent reconciliation cannot consume an overdue slot while its lifecycle lock is held", async () => {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const cron = await crons.create({
    schedule: { cron: "* * * * *", timezone: "UTC" },
    action: "overdue calendar task",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  const slot = cron.nextFireAt!;
  let clock = slot + 120_000;
  const mutex = testAdvisoryLock();
  const releaseHeld = Promise.withResolvers<void>();
  const heldEntered = Promise.withResolvers<void>();
  const holding = mutex.withLock(`cron-lifecycle:${cron.id}`, async () => {
    heldEntered.resolve();
    await releaseHeld.promise;
  });
  await heldEntered.promise;
  const gates = [0, 1].map(() => ({ entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }));
  let attempts = 0;
  let onFire!: (job: CronFireJob) => Promise<unknown>;
  const enqueued: CronFireJob[] = [];
  const calls: TurnRequest[] = [];
  const scheduler = createScheduler({
    ...schedulerDeps(crons, databaseUrl),
    now: () => clock,
    advisoryLock: {
      ...mutex,
      async tryWithLock(key, fn) {
        const gate = gates[attempts++];
        if (gate) {
          gate.entered.resolve();
          await gate.release.promise;
        }
        return mutex.tryWithLock!(key, fn);
      },
    },
    run: async (req) => {
      calls.push(req);
      return { status: "ok", reply: "done" };
    },
    jobs: {
      handle(name, run) {
        if (name === CRON_FIRE_JOB) onFire = run;
      },
      async spawn(_name, job) {
        enqueued.push(job as CronFireJob);
      },
    },
  });
  const first = onFire({ cronId: cron.id, scheduledAt: slot });
  let second: Promise<unknown> | undefined;
  try {
    await gates[0]!.entered.promise;
    await scheduler.repair();
    clock++;
    second = onFire(enqueued.at(-1)!);
    await gates[1]!.entered.promise;
    gates[0]!.release.resolve();
    await first;
    gates[1]!.release.resolve();
    await second;
    const deferred = (await crons.get(cron.id))!;
    assert.equal(deferred.nextFireAt, slot, "neither claimant can advance past an unstarted calendar slot");
    assert.equal(deferred.lastFiredAt, undefined);
    assert.equal(deferred.deferUntil, clock + 30_000);
    assert.equal(calls.length, 0);
    releaseHeld.resolve();
    await holding;
    clock = deferred.deferUntil!;
    await onFire({ cronId: cron.id, scheduledAt: slot });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.idempotencyKey, `cron:${cron.id}:${slot}`);
    assert.equal((await crons.get(cron.id))!.nextFireAt, slot + 60_000);
  } finally {
    for (const gate of gates) gate.release.resolve();
    releaseHeld.resolve();
    await Promise.all([holding, first, second]);
  }
});

test("queue mode: an authz-failed fire disables the cron but gives the slot back (parity with the interval path)", async () => {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const identity = createIdentityService(databaseUrl);
  let onFire: ((job: { cronId: string; scheduledAt: number }) => Promise<unknown>) | undefined;
  const calls: TurnRequest[] = [];
  createScheduler({
    ...singleProcessDeps(),
    crons,
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(databaseUrl),
    identity,
    run: async (req) => {
      calls.push(req);
      return { status: "ok", reply: "OUT" };
    },
    jobs: {
      handle(name, run) {
        if (name === CRON_FIRE_JOB) onFire = run;
      },
      async spawn() {},
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "my digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await identity.deactivate("U1");
  await settle(async () => onFire !== undefined);
  await onFire!({ cronId: cron.id, scheduledAt: 1 });
  const after = (await crons.get(cron.id))!;
  assert.equal(calls.length, 0, "no turn runs for a departed owner");
  assert.equal(after.enabled, false, "the cron fails closed");
  assert.equal(after.lastFiredAt, undefined, "the slot is not consumed by the authz failure");
  assert.equal(after.nextFireAt, 1, "a later re-enable still owes this fire");
});

test("queue mode: a busy fire releases its slot and its job sleeps until the deferral", async () => {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const calls: TurnRequest[] = [];
  let clock = 5000;
  let onFire: ((job: { cronId: string; scheduledAt: number; notBefore?: number }) => Promise<unknown>) | undefined;
  const enqueued: Array<{ cronId: string; scheduledAt: number; notBefore?: number }> = [];
  createScheduler({
    ...schedulerDeps(crons, databaseUrl),
    run: busyOnce(calls),
    now: () => clock,
    jobs: {
      handle(name, run) {
        if (name === CRON_FIRE_JOB) onFire = run;
      },
      async spawn(_name, job) {
        enqueued.push(job as CronFireJob);
      },
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await settle(async () => onFire !== undefined);
  enqueued.length = 0;

  assert.equal(await onFire!({ cronId: cron.id, scheduledAt: 1 }), 35_000, "same slot, held until the deferral");
  assert.equal(calls.length, 1);
  let stored = (await crons.get(cron.id))!;
  assert.equal(stored.lastFiredAt, undefined, "the busy fire gave its slot back");
  assert.equal(stored.deferUntil, 35_000);

  clock = 10_000;
  assert.equal(await onFire!({ cronId: cron.id, scheduledAt: 1 }), 35_000, "a job arriving early sleeps again");
  assert.equal(calls.length, 1, "a job arriving early is not run");

  clock = 35_000;
  assert.equal(await onFire!({ cronId: cron.id, scheduledAt: 1 }), "done");
  assert.equal(calls.length, 2, "the deferred slot runs");
  stored = (await crons.get(cron.id))!;
  assert.equal(stored.lastFiredAt, 35_000);
  assert.equal(stored.deferUntil, undefined);
  assert.deepEqual(enqueued.pop(), { cronId: cron.id, scheduledAt: 36_000 }, "the next slot is chained without a hold");
});
