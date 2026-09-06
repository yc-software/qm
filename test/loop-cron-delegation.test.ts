import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

const base = { owner: "josh", createdBy: "josh", ownerScopeId: scopeId("personal", "josh") };

function deps(fired: string[], turns: TurnRequest[]) {
  const crons = createCronStore();
  return {
    crons,
    scheduler: createScheduler({
      crons,
      deliveries: { enqueue: async () => ({ id: "d" }) } as never,
      idempotency: createIdempotencyStore(),
      identity: { refresh: async () => {}, classify: () => ({ type: "internal" as const }) } as never,
      run: async (req: TurnRequest): Promise<TurnResult> => {
        turns.push(req);
        return { status: "ok", reply: "done" };
      },
      fireLoop: async (loopId, fireKey) => {
        fired.push(`${loopId}:${fireKey}`);
        return { status: "ok", note: "worked 1" };
      },
    }),
  };
}

test("a loop-backed cron fires the loop instead of running a bare turn", async () => {
  const fired: string[] = [];
  const turns: TurnRequest[] = [];
  const d = deps(fired, turns);
  const cron = await d.crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "fire loop L1", loopId: "L1" });
  await d.scheduler.tick(cron.createdAt + 60_000);
  assert.equal(fired.length, 1);
  assert.match(fired[0]!, /^L1:cron:/);
  assert.deepEqual(turns, []);
  const { runs: after } = await d.crons.listFires(cron.id);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.status, "ok");
  assert.equal(after[0]?.note, "worked 1");
});

test("a plain cron still runs a turn and never touches the loop path", async () => {
  const fired: string[] = [];
  const turns: TurnRequest[] = [];
  const d = deps(fired, turns);
  const cron = await d.crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "say hi" });
  await d.scheduler.tick(cron.createdAt + 60_000);
  assert.deepEqual(fired, []);
  assert.equal(turns.length, 1);
});

test("a failing loop fire is recorded on the cron's fire log and the schedule advances", async () => {
  const turns: TurnRequest[] = [];
  const crons = createCronStore();
  const scheduler = createScheduler({
    crons,
    deliveries: { enqueue: async () => ({ id: "d" }) } as never,
    idempotency: createIdempotencyStore(),
    identity: { refresh: async () => {}, classify: () => ({ type: "internal" as const }) } as never,
    run: async (req: TurnRequest): Promise<TurnResult> => {
      turns.push(req);
      return { status: "ok" };
    },
    fireLoop: async () => {
      throw new Error("loop exploded");
    },
  });
  const cron = await crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "fire loop L1", loopId: "L1" });
  await scheduler.tick(cron.createdAt + 60_000);
  const after = await crons.get(cron.id);
  const { runs } = await crons.listFires(cron.id);
  assert.equal(runs[0]?.status, "failed");
  assert.match(runs[0]?.note ?? "", /loop exploded/);
  assert.equal(after?.enabled, true);
  assert.ok((after?.nextFireAt ?? 0) > cron.createdAt + 60_000);
});

test("a loop-backed cron fails closed when the loop service is unavailable", async () => {
  const turns: TurnRequest[] = [];
  const crons = createCronStore();
  const scheduler = createScheduler({
    crons,
    deliveries: { enqueue: async () => ({ id: "d" }) } as never,
    idempotency: createIdempotencyStore(),
    identity: { refresh: async () => {}, classify: () => ({ type: "internal" as const }) } as never,
    run: async (req: TurnRequest): Promise<TurnResult> => {
      turns.push(req);
      return { status: "ok" };
    },
  });
  const cron = await crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "fire loop L1", loopId: "L1" });
  await scheduler.tick(cron.createdAt + 60_000);
  const { runs } = await crons.listFires(cron.id);
  assert.deepEqual(turns, []);
  assert.equal(runs[0]?.status, "failed");
  assert.equal(runs[0]?.note, "loop service unavailable");
});

test("creating the same loop-backed cron twice dedupes, and loopId distinguishes content", async () => {
  const crons = createCronStore();
  const a = await crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "fire", loopId: "L1" });
  const b = await crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "fire", loopId: "L1" });
  const c = await crons.create({ ...base, schedule: { everyMs: 60_000 }, action: "fire", loopId: "L2" });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal(a.loopId, "L1");
});
