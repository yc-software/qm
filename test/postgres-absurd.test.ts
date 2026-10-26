import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyPgMigrations, definePgMigration, type PoolClient } from "../src/persistence/pg-pool.ts";
import { ABSURD_MIGRATION, TURN_QUEUES, registerAbsurdSchema, type TurnQueue } from "../src/turns/absurd-schema.ts";
import {
  RunFailed,
  TaskCancelled,
  awaitEvent,
  cancelTask,
  claimTasks,
  cleanup,
  completeRun,
  emitEvent,
  extendClaim,
  failRun,
  getCheckpoint,
  holdsClaim,
  scheduleRun,
  spawnTask,
} from "../src/turns/absurd.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Absurd tests";
const T0 = new Date("2026-10-21T16:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let admin: pg.Pool;
let schema: ReturnType<typeof registerAbsurdSchema>;
const clients: PoolClient[] = [];

async function connect(fakeNow?: Date): Promise<PoolClient> {
  const client = await admin.connect();
  clients.push(client);
  if (fakeNow) await client.query("SELECT set_config('absurd.fake_now', $1, false)", [fakeNow.toISOString()]);
  return client;
}

async function runRow(queue: TurnQueue, runId: string) {
  const { rows } = await admin.query(
    `SELECT state, attempt, claimed_by, failure_reason FROM absurd.${pg.escapeIdentifier(`r_${queue}`)} WHERE run_id = $1`,
    [runId],
  );
  return rows[0] as { state: string; attempt: number; claimed_by: string | null; failure_reason: { name?: string } };
}

before(async () => {
  if (!URL) return;
  admin = new pg.Pool({ connectionString: URL, max: 8 });
  schema = registerAbsurdSchema(URL);
  await schema.pool();
});

beforeEach(async () => {
  if (!URL) return;
  for (const queue of TURN_QUEUES) {
    const tables = ["t_", "r_", "c_", "e_", "w_"].map((prefix) => `absurd.${pg.escapeIdentifier(prefix + queue)}`);
    await admin.query(`TRUNCATE ${tables.join(", ")}`);
  }
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.query("SELECT set_config('absurd.fake_now', '', false)");
    client.release();
  }
});

after(async () => {
  if (!URL) return;
  await schema.close();
  await admin.end();
});

test("absurd/0.5.1 applies once and a rerun is a no-op", { skip }, async () => {
  const ledger = async () =>
    (await admin.query("SELECT id, checksum, applied_at FROM qm_schema_migrations WHERE id LIKE 'absurd/%'")).rows;
  const first = await ledger();
  assert.deepEqual(
    first.map((row) => [row.id, row.checksum]),
    [["absurd/0.5.1", ABSURD_MIGRATION.expectedChecksum]],
  );
  const functions = async () =>
    (await admin.query("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'absurd'::regnamespace")).rows[0]!
      .n;
  const before = await functions();
  await applyPgMigrations(admin, [
    definePgMigration(ABSURD_MIGRATION.id, ABSURD_MIGRATION.statements, ABSURD_MIGRATION.expectedChecksum),
  ]);
  assert.deepEqual(await ledger(), first);
  assert.equal(await functions(), before);
  assert.equal((await admin.query("SELECT absurd.get_schema_version() AS v")).rows[0]!.v, "0.5.1");
});

test("the three turn queues exist with a 7-day cleanup TTL", { skip }, async () => {
  const { rows } = await admin.query(
    `SELECT q.queue_name, p.storage_mode, p.cleanup_ttl::text AS ttl
       FROM absurd.list_queues() q, absurd.get_queue_policy(q.queue_name) p ORDER BY q.queue_name`,
  );
  assert.deepEqual(rows, [
    { queue_name: "turns_background", storage_mode: "unpartitioned", ttl: "7 days" },
    { queue_name: "turns_delegated", storage_mode: "unpartitioned", ttl: "7 days" },
    { queue_name: "turns_people", storage_mode: "unpartitioned", ttl: "7 days" },
  ]);
});

test("spawn, claim and complete round-trip", { skip }, async () => {
  const db = await connect(T0);
  const spawned = await spawnTask(db, "turns_people", "turn", { turnId: "t1" }, { maxAttempts: 10 });
  assert.equal(spawned.created, true);
  assert.equal(spawned.attempt, 1);
  const [claimed, ...rest] = await claimTasks(db, "turns_people", "worker-a", 30);
  assert.deepEqual(rest, []);
  assert.equal(claimed!.runId, spawned.runId);
  assert.equal(claimed!.taskName, "turn");
  assert.deepEqual(claimed!.params, { turnId: "t1" });
  assert.equal(claimed!.maxAttempts, 10);
  assert.equal(await holdsClaim(db, "turns_people", claimed!.runId, "worker-a"), true);
  assert.equal(await holdsClaim(db, "turns_people", claimed!.runId, "worker-b"), false);
  await completeRun(db, "turns_people", claimed!.runId, { reply: "done" });
  const { rows } = await admin.query("SELECT state, completed_payload FROM absurd.t_turns_people WHERE task_id = $1", [
    spawned.taskId,
  ]);
  assert.deepEqual(rows, [{ state: "completed", completed_payload: { reply: "done" } }]);
  assert.equal(await holdsClaim(db, "turns_people", claimed!.runId, "worker-a"), false);
  assert.deepEqual(await claimTasks(db, "turns_people", "worker-a", 30), []);
});

test("spawn idempotency key returns the existing task", { skip }, async () => {
  const db = await connect(T0);
  const first = await spawnTask(
    db,
    "turns_background",
    "turn",
    { n: 1 },
    { idempotencyKey: "turn:k", maxAttempts: 10 },
  );
  const again = await spawnTask(
    db,
    "turns_background",
    "turn",
    { n: 2 },
    { idempotencyKey: "turn:k", maxAttempts: 10 },
  );
  assert.equal(again.created, false);
  assert.equal(again.taskId, first.taskId);
  assert.equal(again.runId, first.runId);
});

test("scheduleRun(now) hands the run back with the same attempt and no claim", { skip }, async () => {
  const db = await connect(T0);
  const spawned = await spawnTask(db, "turns_people", "turn", {}, { maxAttempts: 10 });
  const [claimed] = await claimTasks(db, "turns_people", "worker-a", 30);
  await scheduleRun(db, "turns_people", claimed!.runId, T0);
  assert.deepEqual(await runRow("turns_people", claimed!.runId), {
    state: "sleeping",
    attempt: 1,
    claimed_by: null,
    failure_reason: null,
  });
  assert.equal(await holdsClaim(db, "turns_people", claimed!.runId, "worker-a"), false);
  const [resumed] = await claimTasks(db, "turns_people", "worker-b", 30);
  assert.equal(resumed!.runId, spawned.runId);
  assert.equal(resumed!.attempt, 1);
  assert.equal(await holdsClaim(db, "turns_people", resumed!.runId, "worker-b"), true);
  assert.equal(await holdsClaim(db, "turns_people", resumed!.runId, "worker-a"), false);
});

test("an expired lease is swept by the next claim into attempt 2", { skip }, async () => {
  const early = await connect(T0);
  const late = await connect(at(31));
  await spawnTask(early, "turns_delegated", "turn", {}, { maxAttempts: 10 });
  const [first] = await claimTasks(early, "turns_delegated", "worker-a", 30);
  assert.equal(await holdsClaim(early, "turns_delegated", first!.runId, "worker-a"), true);
  const [second] = await claimTasks(late, "turns_delegated", "worker-b", 30);
  assert.equal(second!.taskId, first!.taskId);
  assert.notEqual(second!.runId, first!.runId);
  assert.equal(second!.attempt, 2);
  const old = await runRow("turns_delegated", first!.runId);
  assert.equal(old.state, "failed");
  assert.equal(old.failure_reason.name, "$ClaimTimeout");
  assert.equal(await holdsClaim(late, "turns_delegated", first!.runId, "worker-a"), false);
  assert.equal(await holdsClaim(late, "turns_delegated", second!.runId, "worker-b"), true);
  await assert.rejects(extendClaim(early, "turns_delegated", first!.runId, 30), RunFailed);
});

test("failRun retries at retryAt until max attempts, then fails the task", { skip }, async () => {
  const now = await connect(T0);
  const later = await connect(at(60));
  const spawned = await spawnTask(now, "turns_background", "turn", {}, { maxAttempts: 2 });
  const [first] = await claimTasks(now, "turns_background", "worker-a", 30);
  await failRun(now, "turns_background", first!.runId, { message: "model error" }, at(60));
  assert.deepEqual(await claimTasks(now, "turns_background", "worker-a", 30), []);
  const [second] = await claimTasks(later, "turns_background", "worker-a", 30);
  assert.equal(second!.attempt, 2);
  await failRun(later, "turns_background", second!.runId, { message: "model error" });
  const { rows } = await admin.query("SELECT state, attempts FROM absurd.t_turns_background WHERE task_id = $1", [
    spawned.taskId,
  ]);
  assert.deepEqual(rows, [{ state: "failed", attempts: 2 }]);
  await assert.rejects(failRun(later, "turns_background", second!.runId, {}), RunFailed);
});

test("an event emitted on another connection wakes the waiter; another queue does not", { skip }, async () => {
  const worker = await connect();
  const emitter = await connect();
  const spawned = await spawnTask(worker, "turns_delegated", "turn", {}, { maxAttempts: 10 });
  const [claimed] = await claimTasks(worker, "turns_delegated", "worker-a", 30);
  const waiting = await awaitEvent(worker, "turns_delegated", spawned.taskId, claimed!.runId, "children", "fanin:t1");
  assert.deepEqual(waiting, { suspended: true, timedOut: false, payload: null });
  assert.equal(await holdsClaim(worker, "turns_delegated", claimed!.runId, "worker-a"), false);

  await emitEvent(emitter, "turns_people", "fanin:t1", { children: 3 });
  assert.deepEqual(await claimTasks(worker, "turns_delegated", "worker-b", 30), []);
  assert.equal((await runRow("turns_delegated", claimed!.runId)).state, "sleeping");

  await emitEvent(emitter, "turns_delegated", "fanin:t1", { children: 2 });
  const [woken] = await claimTasks(worker, "turns_delegated", "worker-b", 30);
  assert.equal(woken!.runId, claimed!.runId);
  assert.equal(woken!.attempt, 1);
  assert.deepEqual(woken!.eventPayload, { children: 2 });
  assert.deepEqual(await awaitEvent(worker, "turns_delegated", spawned.taskId, woken!.runId, "children", "fanin:t1"), {
    suspended: false,
    timedOut: false,
    payload: { children: 2 },
  });
  const checkpoint = await getCheckpoint(worker, "turns_delegated", spawned.taskId, "children");
  assert.deepEqual(checkpoint?.state, { children: 2 });
  assert.equal(checkpoint?.ownerRunId, woken!.runId);
  assert.equal(await getCheckpoint(worker, "turns_delegated", spawned.taskId, "missing"), undefined);
});

test("awaitEvent tells a timeout apart from an event emitted without a payload", { skip }, async () => {
  const now = await connect(T0);
  const later = await connect(at(11));
  const timed = await spawnTask(now, "turns_people", "turn", {}, { maxAttempts: 10 });
  const [first] = await claimTasks(now, "turns_people", "worker-a", 30);
  assert.equal(
    (await awaitEvent(now, "turns_people", timed.taskId, first!.runId, "wait", "never", 10)).suspended,
    true,
  );
  const [resumed] = await claimTasks(later, "turns_people", "worker-a", 30);
  assert.deepEqual(await awaitEvent(later, "turns_people", timed.taskId, resumed!.runId, "wait", "never", 10), {
    suspended: false,
    timedOut: true,
    payload: null,
  });
  const emitted = await spawnTask(later, "turns_people", "turn", {}, { maxAttempts: 10 });
  const [second] = await claimTasks(later, "turns_people", "worker-a", 30);
  await emitEvent(later, "turns_people", "resume:t2");
  assert.deepEqual(await awaitEvent(later, "turns_people", emitted.taskId, second!.runId, "wait", "resume:t2"), {
    suspended: false,
    timedOut: false,
    payload: null,
  });
});

test("holdsClaim locks the run so a cancel waits for the fenced transaction", { skip }, async () => {
  const worker = await connect(T0);
  const other = await connect(T0);
  const spawned = await spawnTask(worker, "turns_people", "turn", {}, { maxAttempts: 10 });
  const [claimed] = await claimTasks(worker, "turns_people", "worker-a", 30);
  await worker.query("BEGIN");
  assert.equal(await holdsClaim(worker, "turns_people", claimed!.runId, "worker-a"), true);
  let cancelled = false;
  const cancel = cancelTask(other, "turns_people", spawned.taskId).then(() => (cancelled = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(cancelled, false);
  await worker.query("COMMIT");
  await cancel;
  assert.equal(await holdsClaim(worker, "turns_people", claimed!.runId, "worker-a"), false);
});

test("cancelTask makes the worker's next extendClaim raise TaskCancelled", { skip }, async () => {
  const worker = await connect(T0);
  const other = await connect(T0);
  const spawned = await spawnTask(worker, "turns_people", "turn", {}, { maxAttempts: 10 });
  const [claimed] = await claimTasks(worker, "turns_people", "worker-a", 30);
  await extendClaim(worker, "turns_people", claimed!.runId, 30);
  await cancelTask(other, "turns_people", spawned.taskId);
  await assert.rejects(extendClaim(worker, "turns_people", claimed!.runId, 30), TaskCancelled);
  await assert.rejects(completeRun(worker, "turns_people", claimed!.runId), TaskCancelled);
});

test("spawnTask inside a rolled-back transaction leaves no task", { skip }, async () => {
  const db = await connect(T0);
  await db.query("BEGIN");
  await spawnTask(db, "turns_people", "turn", { turnId: "rolled-back" }, { maxAttempts: 10 });
  await db.query("ROLLBACK");
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM absurd.t_turns_people");
  assert.equal(rows[0]!.n, 0);
  assert.deepEqual(await claimTasks(db, "turns_people", "worker-a", 30), []);
});

test("cleanup deletes finished tasks and events past the TTL", { skip }, async () => {
  const then = await connect(T0);
  const later = await connect(at(8 * 86_400));
  await spawnTask(then, "turns_background", "turn", {}, { maxAttempts: 10 });
  const [claimed] = await claimTasks(then, "turns_background", "worker-a", 30);
  await completeRun(then, "turns_background", claimed!.runId);
  await emitEvent(then, "turns_background", "done:t1", {});
  assert.deepEqual(await cleanup(then, "turns_background", 7 * 86_400, 100), { tasks: 0, events: 0 });
  assert.deepEqual(await cleanup(later, "turns_background", 7 * 86_400, 100), { tasks: 1, events: 1 });
});
