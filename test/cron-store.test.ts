import { test } from "node:test";
import assert from "node:assert/strict";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
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

  const after = await store.getRuns(cron.id);
  assert.deepEqual(
    after.runs.map((entry) => entry.fireKey),
    ["f1", "f2"],
  );
  assert.equal(after.runs[1]?.threadRef, "cron:c:fire:2b");
  assert.equal(after.runs[1]?.reply, "second updated");
});

test("due scheduler scans do not load persisted fire history", async () => {
  const backing = createMemoryMap<Cron>();
  await backing.put("old", {
    ...base,
    id: "old",
    schedule: { firstFireAt: 1 },
    enabled: true,
    createdAt: 0,
    fireLog: Array.from({ length: 100 }, (_, i) => ({
      fireKey: `fire-${i}`,
      threadRef: `cron:old:fire-${i}`,
      firedAt: i,
      reply: "x".repeat(10_000),
    })),
  });

  const store = createCronStore(backing);
  const [due] = await store.due(1);
  assert.equal(due?.fireLog, undefined);
  assert.equal((await backing.get("old"))?.fireLog, undefined);
  assert.equal((await store.getRuns("old")).total, 100);
});

test("fire history remains complete while reads can page the newest entries", async () => {
  const store = createCronStore();
  const cron = await store.create({ ...base, schedule: { everyMs: 1000 } });
  for (let i = 1; i <= 3; i++) {
    await store.recordFire(cron.id, { fireKey: `f${i}`, threadRef: `cron:f${i}`, firedAt: i });
  }
  assert.deepEqual(await store.getRuns(cron.id, 2), {
    runs: [
      { fireKey: "f2", threadRef: "cron:f2", firedAt: 2 },
      { fireKey: "f3", threadRef: "cron:f3", firedAt: 3 },
    ],
    total: 3,
  });
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
