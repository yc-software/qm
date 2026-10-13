import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryTidyService, MEMORY_TIDY_TASK, type MemoryTidyProfile } from "../src/memory/tidy.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { MemoryFact } from "../src/memory/facts.ts";
import { scopeId, type Principal, type ScopeId, type TurnRequest } from "../src/types.ts";

function fixture() {
  const notebooks = new Map<ScopeId, MemoryFact[]>();
  const timezones = new Map<string, string>();
  const members = new Map<ScopeId, Principal[]>();
  const store = createMemoryMap<MemoryTidyProfile>();
  const crons = createCronStore();
  const calls: TurnRequest[] = [];
  const fact = (updatedAt: number): MemoryFact => ({
    id: String(updatedAt),
    text: "Prefers concise replies",
    sensitivity: "ordinary",
    sources: [],
    sourceUnknown: false,
    createdAt: updatedAt,
    updatedAt,
  });
  const service = createMemoryTidyService({
    store,
    memory: {
      metadata: async () => new Map([...notebooks].map(([scope, facts]) => [scope, { bytes: facts.length }])),
      facts: async (scope) => notebooks.get(scope) ?? [],
    },
    timezone: async (id) => timezones.get(id),
    members: async (scope) => members.get(scope),
    crons,
    scheduler: { notifyChanged: () => {} },
  });
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    identity: createIdentityService(),
    idempotency: createIdempotencyStore(),
    skipFire: (cron) => service.skipFire(cron),
    run: async (request) => {
      calls.push(request);
      return { status: "silent" };
    },
  });
  const cronOf = async (id: string) => (await crons.get((await store.get(scopeId("personal", id)))!.cronId!))!;
  const fireAt = async (id: string, at: number) => {
    const cron = await cronOf(id);
    await crons.update(cron.id, { schedule: { everyMs: 60_000 } });
    await scheduler.tick(at);
    await crons.update(cron.id, { schedule: cron.schedule });
  };
  return { notebooks, timezones, members, store, crons, calls, service, scheduler, cronOf, fact, fireAt };
}

test("creates one nightly tidy cron per notebook, near 3 AM in the owner's timezone", async () => {
  const f = fixture();
  const channel = scopeId("channel", "C1");
  f.notebooks.set(scopeId("personal", "alice"), [f.fact(1)]);
  f.notebooks.set(scopeId("personal", "bob"), [f.fact(1)]);
  f.notebooks.set(channel, [f.fact(1)]);
  f.notebooks.set(scopeId("channel", "C2"), [f.fact(1)]);
  f.members.set(channel, [{ id: "carol", type: "internal" }]);
  f.timezones.set("alice", "Europe/London");
  await f.service.maintain();
  await f.service.maintain();

  assert.equal((await f.crons.list()).length, 3);
  const alice = await f.cronOf("alice");
  assert.match(alice.schedule.cron!, /^\d+ 3 \* \* \*$/);
  assert.equal(alice.schedule.timezone, "Europe/London");
  assert.equal(alice.ownerScopeId, scopeId("personal", "alice"));
  assert.equal(alice.runAs, "owner");
  assert.equal((await f.cronOf("bob")).schedule.timezone, "America/Los_Angeles");
  const shared = (await f.crons.get((await f.store.get(channel))!.cronId!))!;
  assert.equal(shared.ownerScopeId, channel);
  assert.equal(shared.owner, "carol");
  assert.equal(shared.runAs, "scopeFloor");
});

test("a scheduled fire runs the tidy only when the notebook changed since the last tidy", async () => {
  const f = fixture();
  const scope = scopeId("personal", "alice");
  f.notebooks.set(scope, [f.fact(1)]);
  await f.service.maintain();
  const id = (await f.cronOf("alice")).id;

  await f.fireAt("alice", Date.now() + 120_000);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.text, /memory notebook/);
  assert.equal(f.calls[0]!.surface, "cron");

  await f.fireAt("alice", Date.now() + 240_000);
  assert.equal(f.calls.length, 1);
  const { runs } = await f.crons.listFires(id);
  assert.equal(runs.at(-1)!.status, "silent");
  assert.equal(runs.at(-1)!.sessionId, undefined);

  f.notebooks.set(scope, [f.fact(1), f.fact(Date.now() + 300_000)]);
  await f.fireAt("alice", Date.now() + 360_000);
  assert.equal(f.calls.length, 2);
});

test("a failed tidy does not count, an owner-rewritten task is never skipped, and run-now always runs", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), [f.fact(1)]);
  await f.service.maintain();
  const id = (await f.cronOf("alice")).id;
  await f.crons.recordFire(id, { fireKey: "k1", threadRef: "t1", firedAt: 5, endedAt: 6, status: "failed" });
  assert.equal(await f.service.skipFire(await f.cronOf("alice")), undefined);

  await f.crons.recordFire(id, { fireKey: "k2", threadRef: "t2", firedAt: 7, endedAt: 8, status: "ok" });
  assert.ok(await f.service.skipFire(await f.cronOf("alice")));
  await f.crons.update(id, { action: "Only merge exact duplicates." });
  assert.equal(await f.service.skipFire(await f.cronOf("alice")), undefined);
  const result = await f.scheduler.runNow(id);
  assert.ok(result.started);
  await result.settled;
  assert.equal(f.calls.length, 1);
});

test("respects the owner's edits and deletions", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), [f.fact(1)]);
  await f.service.maintain();
  const id = (await f.cronOf("alice")).id;

  const schedule = { cron: "0 5 * * *", timezone: "America/New_York" };
  await f.crons.update(id, { schedule, action: "Only merge exact duplicates." });
  f.timezones.set("alice", "Asia/Tokyo");
  await f.service.maintain();
  assert.deepEqual((await f.crons.get(id))!.schedule, schedule);
  assert.equal((await f.crons.get(id))!.action, "Only merge exact duplicates.");

  await f.crons.delete(id);
  await f.service.maintain();
  assert.equal((await f.crons.list()).length, 0);
});

test("follows a newly learned timezone and task update while the platform still manages the cron", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), [f.fact(1)]);
  await f.service.maintain();
  const id = (await f.cronOf("alice")).id;
  await f.crons.update(id, { action: "older platform task" });
  await f.store.merge(scopeId("personal", "alice"), { managedAction: "older platform task" });
  f.timezones.set("alice", "Asia/Tokyo");
  await f.service.maintain();
  const cron = (await f.crons.get(id))!;
  assert.equal(cron.schedule.timezone, "Asia/Tokyo");
  assert.equal(cron.action, MEMORY_TIDY_TASK);
});
