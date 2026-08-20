import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createScheduler, type Scheduler } from "../src/cron/scheduler.ts";
import { createPgBossCronQueue } from "../src/cron/job-queue.ts";
import { createCronStore, type CronStore } from "../src/cron/cron-store.ts";
import { createPostgresCronFireStore } from "../src/cron/cron-fire-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { scopeId, type Cron, type TurnRequest, type TurnResult } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron queue tests";

const SCHEMA = "pgboss_cron_queue_test";
const CRONS_TABLE = "cron_queue_test_crons";
const IDEM_TABLE = "cron_queue_test_idempotency";
const FIRES_TABLE = "cron_queue_test_fires";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await p.query(`DROP TABLE IF EXISTS ${CRONS_TABLE}, ${IDEM_TABLE}, ${FIRES_TABLE}`);
  await p.end();
});

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function instance(calls: TurnRequest[], turnMs = 0): { scheduler: Scheduler; crons: CronStore } {
  const maps = createPostgresMapFactory(URL!);
  const crons = createCronStore(
    maps.map<Cron>(CRONS_TABLE),
    createPostgresCronFireStore(maps.pool, CRONS_TABLE, FIRES_TABLE),
  );
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (turnMs) await new Promise((r) => setTimeout(r, turnMs));
    return { status: "ok", reply: "QUEUE-OUTPUT" };
  };
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(maps.map<IdempotencyRecord>(IDEM_TABLE)),
    identity: createIdentityService(),
    run,
    jobQueue: createPgBossCronQueue(URL ?? "", SCHEMA),
  });
  return { scheduler, crons };
}

test(
  "pg-boss queue: a slow fire is not double-run by a sibling instance (durable slot claim)",
  { skip, timeout: 120_000 },
  async () => {
    const calls: TurnRequest[] = [];
    const a = instance(calls, 12_000);
    const b = instance(calls, 12_000);
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
      await until(() => calls.length >= 1, 30_000);
      assert.equal(calls.length, 1, "the due slot starts exactly one turn");
      await new Promise((r) => setTimeout(r, 16_000));
      assert.equal(calls.length, 1, "no sibling or reconcile re-run while (or after) the slow turn runs");
      assert.equal((await b.crons.get(cron.id))?.enabled, false, "the one-shot ends disabled");
      assert.equal((await b.crons.getRuns(cron.id)).runs.length, 1, "one fire recorded");
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
    const a = instance(calls);
    const b = instance(calls);
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
      const fires = () => calls.filter((c) => c.idempotencyKey?.startsWith(`cron:${cron.id}:`)).length;
      await until(() => fires() >= 3, 45_000);
      assert.ok(fires() >= 3, "a recurring cron chains fire jobs across instances");
      const keys = calls.map((c) => c.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, "no slot fires twice");

      await b.crons.update(cron.id, { schedule: { everyMs: 60_000 } });
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
