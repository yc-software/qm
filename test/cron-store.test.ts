import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCronStore,
  DEFAULT_FIRE_RUNNING_STALE_MS,
  FIRE_RETENTION_KEEP_PER_CRON,
  FIRE_RETENTION_MS,
  STRANDED_FIRE_NOTE,
} from "../src/cron/cron-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemoryCronFireStore } from "../src/cron/fire-store.ts";
import { scopeId, type Cron } from "../src/types.ts";

const base = { action: "x", owner: "U1", createdBy: "U1", ownerScopeId: scopeId("personal", "U1") };
const ids = (cs: { id: string }[]) => cs.map((c) => c.id);

test("a recurring cron does NOT fire immediately — first fire is one interval out", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  const first = cron.schedule.firstFireAt!;
  assert.equal(cron.nextFireAt, first);
  assert.equal(first, cron.createdAt + 60_000);
  assert.deepEqual(ids(await store.due(first - 1)), []);
  assert.deepEqual(ids(await store.due(first)), [cron.id]);
});

test("a calendar cron fires at weekday 9am Pacific and reports the scheduled instant", async (t) => {
  const now = Date.parse("2026-06-18T15:59:59.999Z");
  const scheduledAt = Date.parse("2026-06-18T16:00:00.000Z");
  t.mock.method(Date, "now", () => now);
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { cron: " 0   9 * * 1-5 ", timezone: "America/Los_Angeles" } });
  assert.deepEqual(cron.schedule, { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" });
  assert.equal(cron.nextFireAt, scheduledAt);
  assert.deepEqual(ids(await store.due(scheduledAt - 1)), []);
  const due = await store.due(scheduledAt + 5 * 60_000);
  assert.equal(due[0]?.id, cron.id);
  assert.equal(due[0]?.scheduledAt, scheduledAt);
});

test("a calendar cron supports multiple local times per day", async (t) => {
  const now = Date.parse("2026-06-18T17:00:00.000Z");
  t.mock.method(Date, "now", () => now);
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { cron: "0 9,17 * * *", timezone: "America/Los_Angeles" } });
  assert.equal(cron.nextFireAt, Date.parse("2026-06-19T00:00:00.000Z"));
});

test("a late calendar fire advances from the scheduled instant, not the tick instant", async (t) => {
  const now = Date.parse("2026-06-18T15:58:00.000Z");
  t.mock.method(Date, "now", () => now);
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { cron: "0 9,17 * * *", timezone: "America/Los_Angeles" } });
  const scheduledAt = Date.parse("2026-06-18T16:00:00.000Z");
  assert.equal(cron.nextFireAt, scheduledAt);

  await store.markFired(cron.id, Date.parse("2026-06-19T01:00:00.000Z"), scheduledAt);
  const after = await store.get(cron.id);
  assert.equal(after?.lastFiredAt, Date.parse("2026-06-19T01:00:00.000Z"));
  assert.equal(after?.nextFireAt, Date.parse("2026-06-19T00:00:00.000Z"));
});

test("a sparse calendar cron finds the next valid month/day", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2025-01-01T00:00:00.000Z"));
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { cron: "0 9 29 2 *", timezone: "America/Los_Angeles" } });
  assert.equal(cron.nextFireAt, Date.parse("2028-02-29T17:00:00.000Z"));
});

test("calendar crons preserve local wall-clock time across DST shifts", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-03-07T12:00:00.000Z"));
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" } });
  const first = Date.parse("2026-03-07T17:00:00.000Z");
  assert.equal(cron.nextFireAt, first);
  await store.markFired(cron.id, Date.parse("2026-03-07T17:05:00.000Z"), first);
  assert.equal((await store.get(cron.id))?.nextFireAt, Date.parse("2026-03-08T16:00:00.000Z"));
});

test("calendar schedule validation is 5-field and timezone-aware", async () => {
  const store = createCronStore();
  await assert.rejects(
    () => store.create({ ...base, schedule: { cron: "@daily", timezone: "America/Los_Angeles" } }),
    /5-field/,
  );
  await assert.rejects(
    () => store.create({ ...base, schedule: { cron: "0 0 9 * * *", timezone: "America/Los_Angeles" } }),
    /5-field/,
  );
  await assert.rejects(
    () => store.create({ ...base, schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } }),
    /timezone/,
  );
});

test("a recurring cron fires once per interval after the last fire", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } });
  assert.deepEqual(ids(await store.due(1_000_000)), [cron.id]);
  await store.markFired(cron.id, 1_000_000);
  assert.equal((await store.get(cron.id))?.nextFireAt, 1_060_000);
  assert.deepEqual(ids(await store.due(1_059_999)), []);
  assert.deepEqual(ids(await store.due(1_060_000)), [cron.id]);
});

test("a one-shot cron (no everyMs) fires once at firstFireAt and never again", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { firstFireAt: 5_000_000 } });
  assert.deepEqual(ids(await store.due(4_999_999)), []);
  assert.deepEqual(ids(await store.due(5_000_000)), [cron.id]);
  await store.markFired(cron.id, 5_000_000);
  assert.equal((await store.get(cron.id))?.nextFireAt, undefined);
  assert.deepEqual(ids(await store.due(9_999_999_999)), []);
});

test("old persisted interval rows without nextFireAt still recover their due cursor", async () => {
  const backing = createMemoryMap<Cron>();
  await backing.put("old", {
    ...base,
    id: "old",
    schedule: { everyMs: 1000, firstFireAt: 2000 },
    enabled: true,
    createdAt: 1000,
    lastFiredAt: 5000,
  });
  const store = createCronStore(backing);
  assert.deepEqual(ids(await store.due(5999)), []);
  const due = await store.due(6000);
  assert.equal(due[0]?.id, "old");
  assert.equal(due[0]?.scheduledAt, 6000);
});

test("a disabled cron is never due", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { firstFireAt: 1 } });
  await store.setEnabled(cron.id, false);
  assert.deepEqual(ids(await store.due(1_000_000)), []);
});

test("an archived cron is disabled and never due until re-enabled", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { firstFireAt: 1 } });
  const archived = await store.update(cron.id, { archived: true });
  assert.equal(archived?.archived, true);
  assert.equal(archived?.enabled, false);
  assert.deepEqual(ids(await store.due(1_000_000)), []);

  await store.setEnabled(cron.id, true);
  const resumed = await store.get(cron.id);
  assert.equal(resumed?.archived, false);
  assert.equal(resumed?.enabled, true);
  assert.deepEqual(ids(await store.due(1_000_000)), [cron.id]);
});

test("update patches action + schedule in place, preserving identity", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, title: " Inbox digest ", schedule: { everyMs: 60_000 } });
  const updated = await store.update(cron.id, {
    title: "Daily inbox digest",
    action: "y",
    schedule: { everyMs: 120_000, firstFireAt: 9_999 },
  });
  assert.equal(updated?.id, cron.id);
  assert.equal(updated?.owner, "U1");
  assert.equal(updated?.createdBy, "U1");
  assert.equal(updated?.ownerScopeId, base.ownerScopeId);
  assert.equal(updated?.createdAt, cron.createdAt);
  assert.equal(cron.title, "Inbox digest");
  assert.equal(updated?.title, "Daily inbox digest");
  assert.equal(updated?.action, "y");
  assert.equal(updated?.schedule.everyMs, 120_000);
  assert.equal(updated?.schedule.firstFireAt, 9_999);
});

test("update with a schedule lacking firstFireAt resets it one interval out (not immediately due)", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1 } });
  const before = Date.now();
  const updated = await store.update(cron.id, { schedule: { everyMs: 120_000 } });
  const after = Date.now();
  const first = updated!.schedule.firstFireAt!;
  assert.ok(first >= before + 120_000 && first <= after + 120_000, `expected ~now+everyMs, got ${first}`);
  assert.deepEqual(ids(await store.due(Date.now())), [], "the rescheduled cron is not immediately due");
});

test("update can pause/resume via the enabled flag", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { firstFireAt: 1 } });
  await store.update(cron.id, { enabled: false });
  assert.deepEqual(ids(await store.due(1_000_000)), []);
  await store.update(cron.id, { enabled: true });
  assert.deepEqual(ids(await store.due(1_000_000)), [cron.id]);
});

test("update returns null for an unknown id", async () => {
  const store = createCronStore();
  assert.equal(await store.update("nope", { action: "x" }), null);
});

test("delete removes a cron from list and due", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { firstFireAt: 1 } });
  await store.delete(cron.id);
  assert.equal(await store.get(cron.id), null);
  assert.deepEqual(ids(await store.list()), []);
  assert.deepEqual(ids(await store.due(1_000_000)), []);
});

test("recordFire appends compact durable fire log entries and replaces duplicate fire keys", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 1000 } });
  await store.recordFire(cron.id, {
    fireKey: "f2",
    threadRef: "cron:c:fire:2",
    firedAt: 20,
    status: "ok",
    reply: "second",
  });
  await store.recordFire(cron.id, {
    fireKey: "f1",
    threadRef: "cron:c:fire:1",
    firedAt: 10,
    status: "failed",
    note: "first failed",
  });
  await store.recordFire(cron.id, {
    fireKey: "f2",
    threadRef: "cron:c:fire:2b",
    firedAt: 25,
    status: "ok",
    reply: "second updated",
  });

  const { runs } = await store.listFires(cron.id);
  assert.deepEqual(
    runs.map((entry) => entry.fireKey),
    ["f1", "f2"],
  );
  assert.equal(runs[1]?.threadRef, "cron:c:fire:2b");
  assert.equal(runs[1]?.reply, "second updated");
  assert.equal((await store.get(cron.id))?.fireLog, undefined, "the legacy json fireLog is never written");
});

test("create stores runAs + member snapshot for a scopeFloor cron", async () => {
  const store = createCronStore();
  const members = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const cron = await store.create({
    ...base,
    ownerScopeId: scopeId("channel", "C"),
    schedule: { everyMs: 1000 },
    runAs: "scopeFloor",
    members,
  });
  assert.equal(cron.runAs, "scopeFloor");
  assert.deepEqual(
    cron.members?.map((m) => m.id),
    ["U1", "U2"],
  );
  const owned = await store.create({ ...base, schedule: { everyMs: 1000 } });
  assert.equal(owned.runAs, undefined);
  assert.equal(owned.members, undefined);
});

test("markFired does not clobber a concurrent setEnabled(false) (field-level update)", async () => {
  const backing = createMemoryMap<Cron>();
  const slowReads: DurableMap<Cron> = {
    ...backing,
    get: async (id) => {
      await new Promise((r) => setTimeout(r, 5));
      return backing.get(id);
    },
  };
  const store = createCronStore(slowReads);
  const cron = await store.create({ ...base, schedule: { everyMs: 1000 } });
  await Promise.all([store.markFired(cron.id, 123), store.setEnabled(cron.id, false)]);
  const after = await backing.get(cron.id);
  assert.equal(after?.enabled, false, "the disable must survive the concurrent fire stamp");
  assert.equal(after?.lastFiredAt, 123);
});

test("setDestination(undefined) removes the destination field", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 1000 } });
  await store.setDestination(cron.id, { type: "slack", target: "C1" });
  assert.equal((await store.get(cron.id))?.destination?.target, "C1");
  await store.setDestination(cron.id, undefined);
  assert.equal("destination" in ((await store.get(cron.id)) ?? {}), false);
});

test("create dedups a byte-identical retry: same input inserts once and returns the same id", async () => {
  const store = createCronStore();
  const input = {
    ...base,
    schedule: { everyMs: 60_000, firstFireAt: 1_000_000 },
    message: "ping",
    destination: { type: "slack", target: "C1" },
  };
  const a = await store.create(input);
  const b = await store.create(input);
  assert.equal(b.id, a.id, "the retry returns the first record, not a new one");
  assert.equal((await store.list()).length, 1, "only one cron was inserted");
});

test("create dedups a retry that omits firstFireAt (the reported {everyMs} blind-retry case)", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const store = createCronStore();
  const a = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  now += 2_600;
  const b = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  assert.equal(b.id, a.id, "a {everyMs} retry dedups despite the firstFireAt being filled per-call");
  assert.equal((await store.list()).length, 1);
});

test("create dedups across schedule-field ordering (semantically identical requests collide)", async () => {
  const store = createCronStore();
  const a = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } });
  const b = await store.create({ ...base, schedule: { firstFireAt: 1_000_000, everyMs: 60_000 } });
  assert.equal(b.id, a.id);
  assert.equal((await store.list()).length, 1);
});

test("create does NOT dedup when any keyed field differs (distinct requests stay distinct)", async () => {
  const store = createCronStore();
  const members = [{ id: "U1", type: "internal" as const }];
  const chan = { ...base, ownerScopeId: scopeId("channel", "C"), runAs: "scopeFloor" as const };
  const a = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 }, action: "x" });
  const diffAction = await store.create({
    ...base,
    schedule: { everyMs: 60_000, firstFireAt: 1_000_000 },
    action: "y",
  });
  const diffSchedule = await store.create({
    ...base,
    schedule: { everyMs: 120_000, firstFireAt: 1_000_000 },
    action: "x",
  });
  const diffMessage = await store.create({
    ...base,
    action: undefined,
    message: "ping",
    schedule: { everyMs: 60_000, firstFireAt: 1_000_000 },
  });
  const diffDest = await store.create({
    ...base,
    schedule: { everyMs: 60_000, firstFireAt: 1_000_000 },
    action: "x",
    destination: { type: "slack", target: "C1" },
  });
  const m1 = await store.create({ ...chan, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 }, members });
  const m2 = await store.create({
    ...chan,
    schedule: { everyMs: 60_000, firstFireAt: 1_000_000 },
    members: [...members, { id: "U2", type: "internal" as const }],
  });
  const ids = new Set([a.id, diffAction.id, diffSchedule.id, diffMessage.id, diffDest.id, m1.id, m2.id]);
  assert.equal(ids.size, 7, "each distinct request — including a different member set — is its own record");
  assert.equal((await store.list()).length, 7);
});

test("a duplicate create returns the existing record WITHOUT clobbering its live fire state", async () => {
  const store = createCronStore();
  const input = { ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } };
  const a = await store.create(input);
  await store.markFired(a.id, 1_000_000);
  const advanced = (await store.get(a.id))!;
  assert.equal(advanced.lastFiredAt, 1_000_000);
  const b = await store.create(input);
  assert.equal(b.id, a.id);
  assert.equal(b.lastFiredAt, 1_000_000, "the retry must not reset the already-fired cron");
  assert.equal(b.nextFireAt, advanced.nextFireAt);
  assert.equal((await store.list()).length, 1);
});

test("create dedup survives a 'restart': a fresh store over the same backing still matches", async () => {
  const backing = createMemoryMap<Cron>();
  const input = { ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } };
  const a = await createCronStore(backing).create(input);
  const b = await createCronStore(backing).create(input);
  assert.equal(b.id, a.id, "the content-keyed id dedups across a process restart");
  assert.equal((await backing.all()).length, 1);
});

test("claimSlot: exactly one claimant wins a slot; the claim advances the schedule", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } });
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_500), true, "the first claim wins");
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_600), false, "a second claim on the same slot loses");
  const after = (await store.get(cron.id))!;
  assert.equal(after.lastFiredAt, 1_000_500);
  assert.equal(after.nextFireAt, 1_060_500, "the claim advances like markFired");
});

test("claimSlot: concurrent claimants on one slot still yield exactly one winner", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } });
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.claimSlot(cron.id, 1_000_000, 1_000_500 + i)),
  );
  assert.equal(
    claims.filter(Boolean).length,
    1,
    "a batch fired in parallel must not run one cron twice — exclusivity is the store's, not the queue's",
  );
});

test("claimSlot: refuses a stale slot, a disabled cron, and an archived cron", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } });
  assert.equal(await store.claimSlot(cron.id, 999, 1_000_500), false, "a slot that isn't the next fire is stale");
  await store.setEnabled(cron.id, false);
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_500), false, "a disabled cron cannot be claimed");
  await store.setEnabled(cron.id, true);
  await store.update(cron.id, { archived: true });
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_500), false, "an archived cron cannot be claimed");
  assert.equal(await store.claimSlot("missing", 1_000_000, 1_000_500), false);
});

test("claimSlot: a one-shot claim consumes the slot for good", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { firstFireAt: 1_000_000 } });
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_500), true);
  const after = (await store.get(cron.id))!;
  assert.equal(after.nextFireAt, undefined, "no next fire remains");
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_600), false);
});

test("unclaimSlot: restores a failed claim so the slot retries, and only that exact claim", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000, firstFireAt: 1_000_000 } });
  await store.markFired(cron.id, 940_000);
  const prior = (await store.get(cron.id))!.lastFiredAt;
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_000_500), true);
  await store.unclaimSlot(cron.id, 1_000_000, 1_000_500, prior);
  const restored = (await store.get(cron.id))!;
  assert.equal(restored.lastFiredAt, 940_000);
  assert.equal(restored.nextFireAt, 1_000_000, "the slot is claimable again");
  assert.equal(await store.claimSlot(cron.id, 1_000_000, 1_001_000), true);
  await store.unclaimSlot(cron.id, 1_000_000, 999, prior);
  assert.equal((await store.get(cron.id))!.lastFiredAt, 1_001_000, "an unclaim for a different claim is a no-op");
});

test("beginFire journals a running entry; recordFire closes the same row with the outcome", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  const entry = { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" as const };
  assert.deepEqual(await store.beginFire(cron.id, entry), { begun: true });
  assert.deepEqual(await store.beginFire(cron.id, entry), { begun: true });
  let { runs: log } = await store.listFires(cron.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "running");
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 5_000, status: "ok" });
  ({ runs: log } = await store.listFires(cron.id));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "ok");
  assert.equal(log[0]!.endedAt, 5_000);
});

test("a retried fireKey re-journals over its terminal row so the retry is visible in flight", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" });
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "failed" });
  assert.deepEqual(
    await store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 3_000, status: "running" }),
    {
      begun: true,
    },
  );
  const { runs: log } = await store.listFires(cron.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "running");
  assert.equal(log[0]!.firedAt, 3_000);
  assert.equal(log[0]!.endedAt, undefined, "the retry sheds the failed attempt's endedAt");
});

test("an exclusive beginFire is refused while a live fire runs, allowed after it ends or goes stale", async () => {
  const store = createCronStore(undefined, { staleRunningMs: 10_000 });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" });
  const refused = await store.beginFire(
    cron.id,
    { fireKey: "k2", threadRef: "t2", firedAt: 2_000, status: "running" },
    { exclusive: true },
  );
  assert.equal(refused.begun, false);
  assert.equal(refused.begun ? "" : refused.running?.fireKey, "k1");
  assert.equal((await store.listFires(cron.id)).total, 1, "a refused fire journals nothing");
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 3_000, status: "ok" });
  const afterEnd = await store.beginFire(
    cron.id,
    { fireKey: "k3", threadRef: "t3", firedAt: 4_000, status: "running" },
    { exclusive: true },
  );
  assert.equal(afterEnd.begun, true);
  const afterStale = await store.beginFire(
    cron.id,
    { fireKey: "k4", threadRef: "t4", firedAt: 14_001, status: "running" },
    { exclusive: true },
  );
  assert.equal(afterStale.begun, true, "a crashed running row stops blocking once stale");
});

test("beginFire on a missing cron reports begun:false", async () => {
  const store = createCronStore();
  const result = await store.beginFire("nope", { fireKey: "k", threadRef: "t", firedAt: 1, status: "running" });
  assert.equal(result.begun, false);
});

test("sweepStrandedFires closes only over-age running rows, as failed with a note", async () => {
  const store = createCronStore(undefined, { staleRunningMs: 10_000 });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "old", threadRef: "t", firedAt: 1_000, status: "running" });
  await store.beginFire(cron.id, { fireKey: "live", threadRef: "t", firedAt: 8_000, status: "running" });
  await store.recordFire(cron.id, { fireKey: "done", threadRef: "t", firedAt: 2_000, endedAt: 2_500, status: "ok" });
  assert.equal(await store.sweepStrandedFires(12_000), 1);
  const { runs: log } = await store.listFires(cron.id);
  const old = log.find((e) => e.fireKey === "old")!;
  assert.equal(old.status, "failed");
  assert.equal(old.endedAt, 12_000);
  assert.equal(old.note, STRANDED_FIRE_NOTE);
  assert.equal(log.find((e) => e.fireKey === "live")!.status, "running");
  assert.equal(log.find((e) => e.fireKey === "done")!.status, "ok");
  assert.equal(await store.sweepStrandedFires(12_000), 0, "a second sweep finds nothing");
});

test("the default staleness bound tracks the run reaper's default max age", () => {
  assert.equal(DEFAULT_FIRE_RUNNING_STALE_MS, 24 * 60 * 60 * 1000);
});

test("a completion after a stranded sweep replaces the row outright — no stranded note survives success", async () => {
  const store = createCronStore(undefined, { staleRunningMs: 10_000 });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" });
  assert.equal(await store.sweepStrandedFires(20_000), 1);
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 21_000, status: "ok" });
  const { runs: log } = await store.listFires(cron.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "ok");
  assert.equal(log[0]!.note, undefined);
  assert.equal(log[0]!.endedAt, 21_000);
});

test("setFireNote stores the shift-change note, overwrites on the next write, and misses cleanly", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  assert.equal(await store.setFireNote(cron.id, { text: "Quiet. Updated data. No issues.", at: 1_000 }), "applied");
  assert.deepEqual((await store.get(cron.id))!.lastFireNote, { text: "Quiet. Updated data. No issues.", at: 1_000 });
  await store.setFireNote(cron.id, { text: "Blocked by 429s for the last 6 hours.", at: 2_000 });
  assert.deepEqual((await store.get(cron.id))!.lastFireNote, {
    text: "Blocked by 429s for the last 6 hours.",
    at: 2_000,
  });
  assert.equal(await store.setFireNote("nope", { text: "x", at: 3_000 }), "missing");
});

test("a slow older fire cannot clobber a newer fire's note — setFireNote keeps the newest at", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.setFireNote(cron.id, { text: "incident resolved", at: 8_000 });
  assert.equal(await store.setFireNote(cron.id, { text: "still investigating outage", at: 7_000 }), "superseded");
  assert.deepEqual((await store.get(cron.id))!.lastFireNote, { text: "incident resolved", at: 8_000 });
  await store.setFireNote(cron.id, { text: "same shift, revised", at: 8_000 });
  assert.equal((await store.get(cron.id))!.lastFireNote?.text, "same shift, revised");
});

test("listFires reads the normalized fire table through the running→ended lifecycle", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" });
  let { runs, total } = await store.listFires(cron.id);
  assert.equal(total, 1);
  assert.equal(runs[0]!.status, "running");
  assert.equal(runs[0]!.endedAt, undefined);
  await store.recordFire(cron.id, {
    fireKey: "k1",
    threadRef: "t1",
    firedAt: 1_000,
    endedAt: 5_000,
    status: "ok",
    reply: "done",
  });
  ({ runs, total } = await store.listFires(cron.id));
  assert.equal(total, 1);
  assert.equal(runs[0]!.status, "ok");
  assert.equal(runs[0]!.endedAt, 5_000);
  assert.equal(runs[0]!.reply, "done");
});

test("listFires with a limit returns the latest entries in firedAt order with the full total", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  for (const [key, at] of [
    ["k1", 1_000],
    ["k3", 3_000],
    ["k2", 2_000],
  ] as const) {
    await store.recordFire(cron.id, {
      fireKey: key,
      threadRef: `t-${key}`,
      firedAt: at,
      endedAt: at + 1,
      status: "ok",
    });
  }
  const { runs, total } = await store.listFires(cron.id, { limit: 2 });
  assert.equal(total, 3);
  assert.deepEqual(
    runs.map((r) => r.fireKey),
    ["k2", "k3"],
  );
});

test("fires outlive their cron — deleting the cron keeps the fire rows readable", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "ok" });
  await store.delete(cron.id);
  assert.equal(await store.get(cron.id), null);
  const { runs, total } = await store.listFires(cron.id);
  assert.equal(total, 1);
  assert.equal(runs[0]!.fireKey, "k1");
});

test("firesByThreadRefs looks up digests across crons by thread ref", async () => {
  const store = createCronStore();
  const a = await store.create({ ...base, schedule: { everyMs: 60_000 }, action: "a" });
  const b = await store.create({ ...base, schedule: { everyMs: 60_000 }, action: "b" });
  await store.recordFire(a.id, {
    fireKey: "ka",
    threadRef: "ta",
    firedAt: 1_000,
    endedAt: 2_000,
    status: "ok",
    reply: "ra",
  });
  await store.recordFire(b.id, {
    fireKey: "kb",
    threadRef: "tb",
    firedAt: 3_000,
    endedAt: 4_000,
    status: "ok",
    note: "nb",
  });
  const records = await store.firesByThreadRefs(["ta", "tb", "missing"]);
  assert.deepEqual(
    records.map((r) => [r.cronId, r.threadRef]),
    [
      [a.id, "ta"],
      [b.id, "tb"],
    ],
  );
});

test("latestFireForThread returns the newest fire journaled under that thread", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "failed" });
  await store.recordFire(cron.id, { fireKey: "k2", threadRef: "t1", firedAt: 3_000, endedAt: 4_000, status: "ok" });
  await store.recordFire(cron.id, { fireKey: "k3", threadRef: "other", firedAt: 5_000, endedAt: 6_000, status: "ok" });
  const latest = await store.latestFireForThread(cron.id, "t1");
  assert.equal(latest?.fireKey, "k2");
  assert.equal(await store.latestFireForThread(cron.id, "nope"), undefined);
});

test("a stranded-fire sweep is mirrored into the fire table", async () => {
  const store = createCronStore(undefined, { staleRunningMs: 10_000 });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "old", threadRef: "t", firedAt: 1_000, status: "running" });
  assert.equal(await store.sweepStrandedFires(20_000), 1);
  const { runs } = await store.listFires(cron.id);
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[0]!.endedAt, 20_000);
  assert.equal(runs[0]!.note, STRANDED_FIRE_NOTE);
});

test("backfillFires copies legacy json fireLog entries into the fire table, idempotently", async () => {
  const backing = createMemoryMap<Cron>();
  await backing.put("legacy", {
    ...base,
    id: "legacy",
    schedule: { everyMs: 1000 },
    enabled: true,
    createdAt: 1,
    fireLog: [
      { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "ok", reply: "one" },
      { fireKey: "k2", threadRef: "t2", firedAt: 3_000, status: "running" },
    ],
  });
  const store = createCronStore(backing);
  assert.deepEqual(await store.listFires("legacy"), { runs: [], total: 0 });
  assert.equal(await store.backfillFires(), 2);
  const { runs, total } = await store.listFires("legacy");
  assert.equal(total, 2);
  assert.equal(runs[0]!.reply, "one");
  assert.equal(runs[1]!.status, "running");
  assert.equal((await backing.get("legacy"))!.fireLog, undefined, "the legacy key is stripped once copied");
  assert.equal(await store.backfillFires(), 0, "a re-run finds nothing left to copy");
  assert.equal((await store.listFires("legacy")).total, 2);
});

test("backfillFires strips an empty legacy fireLog key too", async () => {
  const backing = createMemoryMap<Cron>();
  await backing.put("empty", {
    ...base,
    id: "empty",
    schedule: { everyMs: 1000 },
    enabled: true,
    createdAt: 1,
    fireLog: [],
  });
  const store = createCronStore(backing);
  assert.equal(await store.backfillFires(), 0);
  const after = (await backing.get("empty"))!;
  assert.equal(after.fireLog, undefined);
  assert.equal(after.enabled, true, "stripping touches only the legacy key");
});

test("backfill never regresses an ended fire row back to running", async () => {
  const backing = createMemoryMap<Cron>();
  await backing.put("legacy", {
    ...base,
    id: "legacy",
    schedule: { everyMs: 1000 },
    enabled: true,
    createdAt: 1,
    fireLog: [{ fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" }],
  });
  const store = createCronStore(backing);
  await store.recordFire("legacy", { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "ok" });
  await store.backfillFires();
  const { runs } = await store.listFires("legacy");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "ok", "the stale running snapshot must not clobber the ended row");
  assert.equal(runs[0]!.endedAt, 2_000);
});

test("the stranded sweep works the fire table: an unbackfilled legacy json row is invisible to it", async () => {
  const backing = createMemoryMap<Cron>();
  const store = createCronStore(backing, { staleRunningMs: 10_000 });
  const kept = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(kept.id, { fireKey: "kept-k", threadRef: "t1", firedAt: 1_000, status: "running" });
  await backing.put("gone", {
    ...base,
    id: "gone",
    schedule: { everyMs: 1000 },
    enabled: true,
    createdAt: 1,
    fireLog: [{ fireKey: "gone-k", threadRef: "t2", firedAt: 1_000, status: "running" }],
  });
  assert.equal(await store.sweepStrandedFires(20_000), 1, "only the table row is swept");
  assert.equal((await store.listFires("gone")).total, 0);
  assert.equal((await store.listFires(kept.id)).runs[0]!.status, "failed");
  assert.equal(await store.backfillFires(), 1, "the legacy row reaches the table via backfill");
  assert.equal(await store.sweepStrandedFires(20_000), 1, "and only then can the sweep close it");
});

test("backfill cannot clobber a newer retry of the same fireKey with a stale snapshot", async () => {
  const fires = createMemoryCronFireStore();
  await fires.record("legacy", { fireKey: "slot-1", threadRef: "t1", firedAt: 3_000, status: "running" });
  await fires.backfill("legacy", [
    { fireKey: "slot-1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "failed" },
  ]);
  const { runs } = await fires.listByCron("legacy");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.firedAt, 3_000, "the older snapshot must not clobber the live retry");
  assert.equal(runs[0]!.status, "running");
});

test("the fire table is the journal of record — a write failure surfaces instead of being swallowed", async () => {
  const store = createCronStore(undefined, {
    fires: {
      record: async () => {
        throw new Error("table down");
      },
      beginExclusive: async () => {
        throw new Error("table down");
      },
      sweepStranded: async () => {
        throw new Error("table down");
      },
      pruneEnded: async () => {
        throw new Error("table down");
      },
      backfill: async () => {
        throw new Error("table down");
      },
      listByCron: async () => ({ runs: [], total: 0 }),
      listByThreadRefs: async () => [],
      latestForThread: async () => undefined,
    },
  });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await assert.rejects(
    store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" }),
    /table down/,
  );
  await assert.rejects(
    store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "ok" }),
    /table down/,
  );
  assert.equal((await store.get(cron.id))!.fireLog, undefined, "and nothing falls back to the json key");
});

test("a deferred cron is not due until its deferral passes, and firing clears the deferral", async () => {
  const store = createCronStore();
  const cron = await store.create({
    schedule: { everyMs: 1000 },
    action: "x",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  const slot = cron.nextFireAt!;
  await store.defer(cron.id, slot + 30_000);
  assert.deepEqual(ids(await store.due(slot + 29_999)), [], "deferred crons are held back even when their slot is due");
  assert.deepEqual(ids(await store.due(slot + 30_000)), [cron.id]);

  await store.markFired(cron.id, slot + 30_000, slot);
  assert.equal((await store.get(cron.id))?.deferUntil, undefined, "markFired clears the deferral");

  await store.defer(cron.id, slot + 90_000);
  const next = await store.get(cron.id);
  assert.equal(await store.claimSlot(cron.id, next!.nextFireAt!, slot + 90_000), true);
  assert.equal((await store.get(cron.id))?.deferUntil, undefined, "claimSlot clears the deferral");
});

test("pruneEnded deletes old ended rows beyond the keep window; running and recent rows survive", async () => {
  const fires = createMemoryCronFireStore();
  await fires.record("c1", { fireKey: "k1", threadRef: "t1", firedAt: 1, endedAt: 10, status: "ok" });
  await fires.record("c1", { fireKey: "k2", threadRef: "t2", firedAt: 2, endedAt: 20, status: "failed" });
  await fires.record("c1", { fireKey: "k3", threadRef: "t3", firedAt: 3, endedAt: 30, status: "ok" });
  await fires.record("c1", { fireKey: "k4", threadRef: "t4", firedAt: 4, status: "running" });
  await fires.record("c1", { fireKey: "k5", threadRef: "t5", firedAt: 5, endedAt: 24, status: "ok" });
  await fires.record("c2", { fireKey: "other", threadRef: "t6", firedAt: 1, endedAt: 2, status: "ok" });
  const pruned = await fires.pruneEnded({ endedBefore: 25, keepPerCron: 2 });
  assert.equal(pruned, 2, "k1 and k2: beyond the keep window AND ended before the cutoff");
  assert.deepEqual(
    (await fires.listByCron("c1")).runs.map((r) => r.fireKey),
    ["k3", "k4", "k5"],
    "k3 ended after the cutoff, k4 still runs, k5 sits inside the keep window",
  );
  assert.equal((await fires.listByCron("c2")).total, 1, "a cron inside its keep window is untouched");
});

test("pruneFires applies the retention constants: nothing prunes inside the keep window", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  for (let i = 0; i <= FIRE_RETENTION_KEEP_PER_CRON; i++) {
    await store.recordFire(cron.id, { fireKey: `k${i}`, threadRef: `t${i}`, firedAt: i, endedAt: i + 1, status: "ok" });
  }
  const now = FIRE_RETENTION_MS + 1_000_000;
  assert.equal(await store.pruneFires(now), 1, "only the row beyond the keep window goes");
  const { runs, total } = await store.listFires(cron.id);
  assert.equal(total, FIRE_RETENTION_KEEP_PER_CRON);
  assert.equal(runs[0]!.fireKey, "k1", "the oldest row is the one pruned");
});

test("beginExclusive re-begins the SAME fireKey without refusing itself", async () => {
  const store = createCronStore(undefined, { staleRunningMs: 10_000 });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  const entry = { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" as const };
  assert.deepEqual(await store.beginFire(cron.id, entry, { exclusive: true }), { begun: true });
  assert.deepEqual(
    await store.beginFire(cron.id, { ...entry, firedAt: 2_000 }, { exclusive: true }),
    { begun: true },
    "a retry of the same fireKey is not blocked by its own running row",
  );
  assert.equal((await store.listFires(cron.id)).total, 1);
});

test("backfillFires survives a cron deleted mid-loop: entries still reach the table, others still strip", async () => {
  const backing = createMemoryMap<Cron>();
  const vanishing: DurableMap<Cron> = {
    ...backing,
    update: async (id, fn) => (id === "gone" ? null : backing.update!(id, fn)),
  };
  const legacyRow = (id: string): Cron => ({
    ...base,
    id,
    schedule: { everyMs: 1000 },
    enabled: true,
    createdAt: 1,
    fireLog: [{ fireKey: `${id}-k`, threadRef: `t-${id}`, firedAt: 1_000, endedAt: 2_000, status: "ok" }],
  });
  await backing.put("gone", legacyRow("gone"));
  await backing.put("stays", legacyRow("stays"));
  const store = createCronStore(vanishing);
  assert.equal(await store.backfillFires(), 2, "a mid-loop deletion never aborts the backfill");
  assert.equal((await store.listFires("gone")).total, 1, "the deleted cron's history still reaches the table");
  assert.equal((await store.listFires("stays")).total, 1);
  assert.equal((await backing.get("stays"))!.fireLog, undefined, "the surviving cron is still stripped");
});
