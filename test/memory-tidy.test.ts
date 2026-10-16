import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryTidyService, withMemoryTidy, type MemoryTidyProfile } from "../src/memory/tidy.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { MemoryFact } from "../src/memory/facts.ts";
import { scopeId, type ScopeId, type TurnRequest } from "../src/types.ts";

function fixture() {
  const notebooks = new Map<ScopeId, MemoryFact[]>();
  const timezones = new Map<string, string>();
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
  const deps = {
    store,
    memory: { facts: async (scope: ScopeId) => notebooks.get(scope) ?? [] },
    timezone: async (id: string) => timezones.get(id),
    crons,
    scheduler: { notifyChanged: () => {} },
  };
  const service = createMemoryTidyService(deps);
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
  const cronOf = async (scope: ScopeId) => (await crons.get((await store.get(scope))!.cronId!))!;
  const fireAt = async (scope: ScopeId, at: number) => {
    const cron = await cronOf(scope);
    await crons.update(cron.id, { schedule: { everyMs: 60_000 } });
    await scheduler.tick(at);
    await crons.update(cron.id, { schedule: cron.schedule });
  };
  return { deps, notebooks, timezones, store, crons, calls, service, scheduler, cronOf, fact, fireAt };
}

const alice = scopeId("personal", "alice");

test("the first fact in a notebook creates its nightly tidy cron near 3 AM", async () => {
  const f = fixture();
  const channel = scopeId("channel", "C1");
  f.timezones.set("alice", "Europe/London");
  for (const scope of [alice, scopeId("personal", "bob"), channel, scopeId("team", "T1")]) {
    await f.service.ensure(scope);
    await f.service.ensure(scope);
  }
  await createMemoryTidyService(f.deps).ensure(channel);

  assert.equal((await f.crons.list()).length, 3);
  const personal = await f.cronOf(alice);
  assert.match(personal.schedule.cron!, /^\d+ 3 \* \* \*$/);
  assert.equal(personal.schedule.timezone, "Europe/London");
  assert.equal(personal.owner, "alice");
  assert.equal((await f.cronOf(scopeId("personal", "bob"))).schedule.timezone, "America/Los_Angeles");
  const shared = await f.cronOf(channel);
  assert.equal(shared.ownerScopeId, channel);
  assert.equal(shared.owner, "system:channel:C1");
});

test("a claim interrupted before its cron was switched on is finished on the next capture", async () => {
  const f = fixture();
  const cron = await f.crons.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: alice,
    schedule: { cron: "7 3 * * *", timezone: "UTC" },
    action: "tidy",
    enabled: false,
  });
  await f.store.put(alice, { cronId: cron.id, arming: true });
  await f.service.ensure(alice);
  assert.equal((await f.crons.get(cron.id))?.enabled, true);
  assert.deepEqual(await f.store.get(alice), { cronId: cron.id });
  assert.equal((await f.crons.list()).length, 1);

  await f.crons.setEnabled(cron.id, false);
  await f.service.ensure(alice);
  assert.equal((await f.crons.get(cron.id))?.enabled, false, "a cron someone switched off stays off");
});

test("captures that add facts ensure the notebook's tidy cron, including through disclosed views", async () => {
  const ensured: ScopeId[] = [];
  let added = 1;
  const base = { capture: async () => added, withDisclosure: () => base } as unknown as MemoryService;
  const memory = withMemoryTidy(base, async (scope) => {
    ensured.push(scope);
  });
  await memory.capture(alice, ["fact"], 0);
  added = 0;
  await memory.capture(scopeId("personal", "bob"), ["duplicate"], 0);
  added = 2;
  await memory.withDisclosure!({} as never).capture(scopeId("channel", "C1"), ["fact"], 0);
  assert.deepEqual(ensured, [alice, scopeId("channel", "C1")]);
});

test("a scheduled fire runs the tidy only when the notebook changed since the last tidy", async () => {
  const f = fixture();
  f.notebooks.set(alice, [f.fact(1)]);
  await f.service.ensure(alice);
  const id = (await f.cronOf(alice)).id;

  await f.fireAt(alice, Date.now() + 120_000);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.text, /memory notebook/);
  assert.equal(f.calls[0]!.surface, "cron");

  await f.fireAt(alice, Date.now() + 240_000);
  assert.equal(f.calls.length, 1);
  const { runs } = await f.crons.listFires(id);
  assert.equal(runs.at(-1)!.status, "silent");
  assert.equal(runs.at(-1)!.sessionId, undefined);

  f.notebooks.set(alice, [f.fact(1), f.fact(Date.now() + 300_000)]);
  await f.fireAt(alice, Date.now() + 360_000);
  assert.equal(f.calls.length, 2);
});

test("a failed tidy does not count, and run-now always runs", async () => {
  const f = fixture();
  f.notebooks.set(alice, [f.fact(1)]);
  await f.service.ensure(alice);
  const id = (await f.cronOf(alice)).id;
  await f.crons.recordFire(id, { fireKey: "k1", threadRef: "t1", firedAt: 5, endedAt: 6, status: "failed" });
  assert.equal(await f.service.skipFire(await f.cronOf(alice)), undefined);

  await f.crons.recordFire(id, { fireKey: "k2", threadRef: "t2", firedAt: 7, endedAt: 8, status: "ok" });
  assert.ok(await f.service.skipFire(await f.cronOf(alice)));
  const result = await f.scheduler.runNow(id);
  assert.ok(result.started);
  await result.settled;
  assert.equal(f.calls.length, 1);
});

test("never overrides the owner's edits or recreates a deleted tidy cron", async () => {
  const f = fixture();
  await f.service.ensure(alice);
  const id = (await f.cronOf(alice)).id;
  const schedule = { cron: "0 5 * * *", timezone: "America/New_York" };
  await f.crons.update(id, { schedule });
  await createMemoryTidyService(f.deps).ensure(alice);
  assert.deepEqual((await f.crons.get(id))!.schedule, schedule);
  await f.crons.delete(id);
  await createMemoryTidyService(f.deps).ensure(alice);
  assert.equal((await f.crons.list()).length, 0);
});

test("a tidy cron still on older platform instructions picks up the current ones, unless someone rewrote them", async () => {
  const f = fixture();
  await f.service.ensure(alice);
  const { id, action: current } = await f.cronOf(alice);
  await f.crons.update(id, { action: "older platform instructions" });
  await f.store.put(alice, { cronId: id });
  await f.service.ensure(alice);
  assert.equal((await f.crons.get(id))!.action, current);

  await f.store.put(alice, { cronId: id, managedAction: "older platform instructions" });
  await f.service.ensure(alice);
  assert.deepEqual(await f.store.get(alice), { cronId: id, managedAction: current }, "a half-finished refresh heals");

  await f.crons.update(id, { action: "Only merge exact duplicates." });
  await f.store.put(alice, { cronId: id, managedAction: "older platform instructions" });
  await f.service.ensure(alice);
  assert.equal((await f.crons.get(id))!.action, "Only merge exact duplicates.");
});
