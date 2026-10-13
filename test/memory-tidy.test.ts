import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createMemoryTidyService, MEMORY_TIDY_TASK, type MemoryTidyProfile } from "../src/memory/tidy.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type ScopeId, type TurnRequest } from "../src/types.ts";

function fixture() {
  const notebooks = new Map<ScopeId, { updatedAt?: number }>();
  const timezones = new Map<string, string>();
  const store = createMemoryMap<MemoryTidyProfile>();
  const crons = createCronStore();
  const calls: TurnRequest[] = [];
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    identity: createIdentityService(),
    idempotency: createIdempotencyStore(),
    run: async (request) => {
      calls.push(request);
      return { status: "silent" };
    },
  });
  const service = createMemoryTidyService({
    store,
    notebooks: async () => notebooks,
    timezone: async (id) => timezones.get(id),
    crons,
    scheduler,
  });
  const cronOf = async (id: string) => crons.get((await store.get(id))!.cronId!);
  return { notebooks, timezones, store, crons, calls, scheduler, service, cronOf };
}

test("creates one nightly tidy cron per personal notebook near 3 AM in the owner's timezone", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), { updatedAt: 1 });
  f.notebooks.set(scopeId("personal", "bob"), { updatedAt: 1 });
  f.notebooks.set(scopeId("channel", "C1"), { updatedAt: 1 });
  f.timezones.set("alice", "Europe/London");
  await f.service.maintain();
  await f.service.maintain();

  const all = await f.crons.list();
  assert.equal(all.length, 2);
  const alice = (await f.cronOf("alice"))!;
  const minute = createHash("sha256").update("alice").digest()[0]! % 60;
  assert.deepEqual(alice.schedule, { cron: `${minute} 3 * * *`, timezone: "Europe/London" });
  assert.equal(alice.ownerScopeId, scopeId("personal", "alice"));
  assert.equal(alice.runAs, "owner");
  assert.equal(alice.action, MEMORY_TIDY_TASK);
  assert.equal(alice.enabled, true);
  assert.equal((await f.cronOf("bob"))!.schedule.timezone, "America/Los_Angeles");
});

test("a fire runs the tidy task as an ordinary cron turn in the owner's personal scope", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), { updatedAt: 1 });
  await f.service.maintain();
  const result = await f.scheduler.runNow((await f.cronOf("alice"))!.id);
  assert.ok(result.started);
  await result.settled;
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.text, /Tidy your memory notebook/);
  assert.equal(f.calls[0]!.actor.externalId, "alice");
  assert.equal(f.calls[0]!.surface, "cron");
});

test("pauses while the notebook is unchanged since the last tidy and resumes once it changes", async () => {
  const f = fixture();
  const scope = scopeId("personal", "alice");
  f.notebooks.set(scope, { updatedAt: 100 });
  await f.service.maintain();
  const id = (await f.cronOf("alice"))!.id;
  await f.crons.recordFire(id, { fireKey: "k1", threadRef: "t1", firedAt: 150, endedAt: 200, status: "silent" });

  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, false);

  f.notebooks.set(scope, { updatedAt: 300 });
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, true);
});

test("a failed fire does not count as a tidy", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), { updatedAt: 100 });
  await f.service.maintain();
  const id = (await f.cronOf("alice"))!.id;
  await f.crons.recordFire(id, { fireKey: "k1", threadRef: "t1", firedAt: 150, endedAt: 200, status: "failed" });
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, true);
});

test("pauses a tidy cron once the notebook is emptied", async () => {
  const f = fixture();
  const scope = scopeId("personal", "alice");
  f.notebooks.set(scope, { updatedAt: 100 });
  await f.service.maintain();
  const id = (await f.cronOf("alice"))!.id;
  f.notebooks.delete(scope);
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, false);
});

test("respects the owner's edits, pauses and deletions", async () => {
  const f = fixture();
  const scope = scopeId("personal", "alice");
  f.notebooks.set(scope, { updatedAt: 100 });
  await f.service.maintain();
  const id = (await f.cronOf("alice"))!.id;

  const schedule = { cron: "0 5 * * *", timezone: "America/New_York" };
  await f.crons.update(id, { schedule, action: "Only merge exact duplicates." });
  f.timezones.set("alice", "Asia/Tokyo");
  await f.service.maintain();
  assert.deepEqual((await f.crons.get(id))!.schedule, schedule);
  assert.equal((await f.crons.get(id))!.action, "Only merge exact duplicates.");

  await f.crons.setEnabled(id, false);
  f.notebooks.set(scope, { updatedAt: 500 });
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, false);

  await f.crons.delete(id);
  await f.service.maintain();
  assert.equal((await f.crons.list()).length, 0);
});

test("follows a newly learned timezone and task update while the cron is still platform-managed", async () => {
  const f = fixture();
  f.notebooks.set(scopeId("personal", "alice"), { updatedAt: 100 });
  await f.service.maintain();
  const id = (await f.cronOf("alice"))!.id;
  await f.crons.update(id, { action: "older platform task" });
  await f.store.merge("alice", { managedAction: "older platform task" });
  f.timezones.set("alice", "Asia/Tokyo");
  await f.service.maintain();
  const cron = (await f.crons.get(id))!;
  assert.equal(cron.schedule.timezone, "Asia/Tokyo");
  assert.equal(cron.action, MEMORY_TIDY_TASK);
});
