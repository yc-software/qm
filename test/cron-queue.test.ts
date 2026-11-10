import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createScheduler, type Scheduler } from "../src/cron/scheduler.ts";
import { createPgBossCronQueue, installCronQueue, type CronFireJob, type CronJobQueue } from "../src/cron/job-queue.ts";
import { createCronStore, type CronStore } from "../src/cron/cron-store.ts";
import { type CronFireStore, createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import type { Cron } from "../src/triggers/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";
import { withTenant } from "../src/tenants/context.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron queue tests";

const SCHEMA = "pgboss_cron_queue_test";
const CRONS_TABLE = "cron_queue_test_crons";
const IDEM_TABLE = "cron_queue_test_idempotency";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await p.query(`DROP TABLE IF EXISTS ${CRONS_TABLE}, ${IDEM_TABLE}`);
  await p.end();
  await installCronQueue(URL, SCHEMA);
});

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function recording(queue: CronJobQueue, enqueued: CronFireJob[]): CronJobQueue {
  return {
    ...queue,
    enqueueFire: (job) => {
      enqueued.push(job);
      return queue.enqueueFire(job);
    },
  };
}

function instance(
  calls: TurnRequest[],
  turnMs: number,
  fires: CronFireStore,
  enqueued: CronFireJob[] = [],
  failAfter?: (crons: CronStore) => Promise<unknown>,
): { scheduler: Scheduler; crons: CronStore } {
  const maps = createPostgresMapFactory(URL!);
  const crons = createCronStore(maps.map<Cron>(CRONS_TABLE), { fires });
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (failAfter) throw await failAfter(crons);
    if (turnMs) await new Promise((r) => setTimeout(r, turnMs));
    return { status: "ok", reply: "QUEUE-OUTPUT" };
  };
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(maps.map<IdempotencyRecord>(IDEM_TABLE)),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run,
    jobQueue: recording(createPgBossCronQueue(URL ?? "", SCHEMA), enqueued),
  });
  return { scheduler, crons };
}

test(
  "pg-boss queue: a slow fire is not double-run by a sibling instance (durable slot claim)",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fires = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 12_000, fires);
    const b = instance(calls, 12_000, fires);
    a.scheduler.start(1000);
    b.scheduler.start(1000);
    try {
      const cron = await a.crons.create({
        schedule: { firstFireAt: Date.now() + 500 },
        action: "remind me once",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      });
      withTenant(TEST_TENANT, () => a.scheduler.notifyChanged(cron.id));
      await until(() => calls.length >= 1, 30_000);
      assert.equal(calls.length, 1, "the due slot starts exactly one turn");
      await new Promise((r) => setTimeout(r, 16_000));
      assert.equal(calls.length, 1, "no sibling or reconcile re-run while (or after) the slow turn runs");
      assert.equal((await b.crons.get(cron.id))?.enabled, false, "the one-shot ends disabled");
      assert.equal((await b.crons.listFires(cron.id)).total, 1, "one fire recorded");
    } finally {
      a.scheduler.stop();
      b.scheduler.stop();
      await new Promise((r) => setTimeout(r, 500));
    }
  },
);

test(
  "pg-boss queue: a recurring cron chains fires with unique slots, and a schedule edit invalidates queued slots",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const fireStore = createPostgresCronFireStore(testDatabaseUrl());
    const a = instance(calls, 0, fireStore);
    const b = instance(calls, 0, fireStore);
    a.scheduler.start(1000);
    b.scheduler.start(1000);
    try {
      const cron = await a.crons.create({
        schedule: { everyMs: 2000 },
        action: "poll the queue",
        owner: "U2",
        createdBy: "U2",
        ownerScopeId: scopeId("personal", "U2"),
      });
      withTenant(TEST_TENANT, () => a.scheduler.notifyChanged(cron.id));
      const fires = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fires() >= 3, 45_000);
      assert.ok(fires() >= 3, "a recurring cron chains fire jobs across instances");
      const keys = calls.map((c) => c.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, "no slot fires twice");

      await b.crons.update(cron.id, { schedule: { everyMs: 60_000 } });
      withTenant(TEST_TENANT, () => b.scheduler.notifyChanged(cron.id));
      const at = fires();
      await new Promise((r) => setTimeout(r, 6_000));
      assert.equal(fires(), at, "a rescheduled cron's stale slot jobs do not fire");
    } finally {
      a.scheduler.stop();
      b.scheduler.stop();
      await new Promise((r) => setTimeout(r, 500));
    }
  },
);

test(
  "pg-boss queue: a cron persisted without its fire job is enqueued once by startup reconciliation",
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
    a.scheduler.start(1000);
    b.scheduler.start(1000);
    try {
      const fired = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fired() >= 1, 30_000);
      await new Promise((r) => setTimeout(r, 3_000));
      assert.equal(fired(), 1, "the orphaned slot fires exactly once across both instances");
      assert.equal((await a.crons.listFires(cron.id)).total, 1);
    } finally {
      a.scheduler.stop();
      b.scheduler.stop();
      await new Promise((r) => setTimeout(r, 500));
    }
  },
);

test(
  "pg-boss queue: reconciliation enqueues only slots due within its repair window",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const enqueued: CronFireJob[] = [];
    const a = instance(calls, 0, createPostgresCronFireStore(testDatabaseUrl()), enqueued);
    const owner = { owner: "U4", createdBy: "U4", ownerScopeId: scopeId("personal", "U4") };
    const overdue = await a.crons.create({ ...owner, schedule: { firstFireAt: Date.now() - 1000 }, action: "now" });
    const distant = await a.crons.create({
      ...owner,
      schedule: { firstFireAt: Date.now() + 24 * 60 * 60_000 },
      action: "tomorrow",
    });
    a.scheduler.start(1000);
    try {
      await until(() => calls.some((c) => c.idempotencyKey?.startsWith(`cron:${overdue.id}:`)), 30_000);
      assert.ok(
        enqueued.some((job) => job.cronId === overdue.id),
        "the overdue slot is enqueued",
      );
      assert.ok(!enqueued.some((job) => job.cronId === distant.id), "the distant slot waits for a later pass");
    } finally {
      a.scheduler.stop();
      await new Promise((r) => setTimeout(r, 500));
    }
  },
);
test("pg-boss queue: a fire that reschedules its cron then fails keeps the new schedule", { skip }, async () => {
  const later = { firstFireAt: 4_102_444_800_000 };
  const fail = (crons: CronStore) => crons.update(cron.id, { schedule: later }).then(() => new Error("overloaded"));
  const a = instance([], 0, createPostgresCronFireStore(testDatabaseUrl()), [], fail);
  const owner = { owner: "U4", createdBy: "U4", ownerScopeId: scopeId("personal", "U4") };
  const cron = await a.crons.create({ schedule: { firstFireAt: Date.now() }, action: "reschedule", ...owner });
  a.scheduler.start(1000);
  await new Promise((r) => setTimeout(r, 8_000)).finally(() => a.scheduler.stop());
  assert.equal((await a.crons.get(cron.id))!.nextFireAt, later.firstFireAt);
});
