import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopStore, isRunnable, validLoopIcon } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { scopeId } from "../src/types.ts";

const base = {
  owner: "U1",
  createdBy: "U1",
  ownerScopeId: scopeId("personal", "U1"),
  name: "Sentry triage",
  playbook: "read the issue, write the fix",
  successCondition: "the issue has a linked PR whose tests pass, or park after 5 turns",
};

test("creating the same loop twice is deduped to one record", async () => {
  const store = createLoopStore();
  const first = await store.create(base);
  const second = await store.create(base);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.loop.id, first.loop.id);
  assert.equal((await store.list()).length, 1);
});

test("a new loop starts enabled, healthy, and runnable", async () => {
  const store = createLoopStore();
  const { loop } = await store.create(base);
  assert.equal(loop.state, "enabled");
  assert.equal(loop.enabled, true);
  assert.equal(loop.health, "healthy");
  assert.equal(isRunnable(loop), true);
});

test("state is authoritative and keeps the trigger enabled flag in step", async () => {
  const store = createLoopStore();
  const { loop } = await store.create(base);
  const quarantined = await store.setState(loop.id, "quarantined");
  assert.equal(quarantined?.enabled, false);
  assert.equal(isRunnable(quarantined!), false);
  const resumed = await store.setState(loop.id, "enabled");
  assert.equal(resumed?.enabled, true);
  assert.equal(isRunnable(resumed!), true);
});

test("editing the playbook versions it and records who changed it", async () => {
  const store = createLoopStore();
  const { loop } = await store.create(base);
  const edited = await store.editPlaybook(loop.id, {
    playbook: "read the issue, cluster it, then fix",
    by: "U2",
    note: "skip payments",
  });
  assert.equal(edited?.playbookVersion, 2);
  assert.equal(edited?.playbookHistory.length, 2);
  assert.deepEqual(edited?.playbookHistory.at(-1), {
    version: 2,
    at: edited!.playbookHistory.at(-1)!.at,
    by: "U2",
    note: "skip payments",
  });
});

test("a playbook edit that changes nothing does not manufacture a version", async () => {
  const store = createLoopStore();
  const { loop } = await store.create(base);
  const edited = await store.editPlaybook(loop.id, { playbook: base.playbook, by: "U2" });
  assert.equal(edited?.playbookVersion, 1);
  assert.equal(edited?.playbookHistory.length, 1);
});

test("consecutive failed fires accumulate and a clean fire resets them", async () => {
  const store = createLoopStore();
  const { loop } = await store.create(base);
  await store.recordFireOutcome(loop.id, true);
  const twice = await store.recordFireOutcome(loop.id, true);
  assert.equal(twice?.consecutiveFailedFires, 2);
  const recovered = await store.recordFireOutcome(loop.id, false);
  assert.equal(recovered?.consecutiveFailedFires, 0);
});

test("re-enqueueing the same source key never doubles the work", async () => {
  const ledger = createLoopItemLedger();
  const first = await ledger.enqueue({ loopId: "L1", sourceKey: "SENTRY-42", sourceSummary: "TypeError in checkout" });
  const second = await ledger.enqueue({ loopId: "L1", sourceKey: "SENTRY-42", sourceSummary: "TypeError in checkout" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id);
  assert.equal((await ledger.byLoop("L1")).length, 1);
});

test("claiming an item counts the attempt and records the run", async () => {
  const ledger = createLoopItemLedger();
  const { item } = await ledger.enqueue({ loopId: "L1", sourceKey: "S1" });
  const claimed = await ledger.claim(item.id);
  assert.equal(claimed?.status, "in_progress");
  assert.equal(claimed?.attempts, 1);
  assert.deepEqual((await ledger.recordRun(item.id, "run-1", claimed!.claimToken!))?.runIds, ["run-1"]);
  assert.equal(await ledger.claim(item.id), null);
});

test("two racing claims on one queued item yield exactly one winner", async () => {
  const ledger = createLoopItemLedger();
  const { item } = await ledger.enqueue({ loopId: "L1", sourceKey: "S1" });
  const [first, second] = await Promise.all([ledger.claim(item.id), ledger.claim(item.id)]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal((await ledger.get(item.id))?.attempts, 1);
});

test("a stale item claim cannot mark ready after the lease is reclaimed", async () => {
  const ledger = createLoopItemLedger();
  const { item } = await ledger.enqueue({ loopId: "L1", sourceKey: "S1" });
  const stale = await ledger.claim(item.id, 1_000);
  const current = await ledger.claim(item.id, 601_000);
  assert.ok(current);
  assert.notEqual(current.claimToken, stale?.claimToken);
  assert.equal(await ledger.markReady(item.id, ["stale"], stale!.claimToken!), null);
  assert.equal((await ledger.get(item.id))?.claimToken, current.claimToken);
  assert.equal((await ledger.get(item.id))?.status, "in_progress");
});

test("queue stats report depth and the age of the oldest waiting item", async () => {
  const ledger = createLoopItemLedger();
  const { item } = await ledger.enqueue({ loopId: "L1", sourceKey: "S1" });
  await ledger.enqueue({ loopId: "L1", sourceKey: "S2" });
  const stats = await ledger.stats("L1", item.createdAt + 60_000);
  assert.equal(stats.queued, 2);
  assert.equal(stats.oldestQueuedAgeMs, 60_000);
});

test("loop icons persist and reset without changing identity or automation policy", async () => {
  const store = createLoopStore();
  const { loop } = await store.create({ ...base, icon: "bug" });
  assert.equal((await store.get(loop.id))!.icon, "bug");
  await store.update(loop.id, { icon: "rocket" });
  const edited = (await store.get(loop.id))!;
  assert.equal(edited.icon, "rocket");
  assert.equal(edited.policyVersion, loop.policyVersion);
  assert.equal(edited.playbookVersion, loop.playbookVersion);
  assert.equal(edited.state, loop.state);
  await store.update(loop.id, { icon: null });
  assert.equal((await store.get(loop.id))!.icon, undefined);
  assert.equal((await store.create(base)).loop.id, loop.id);
});

test("custom loop icons persist as bounded PNGs and reset to the source default", async () => {
  const icon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  assert.equal(validLoopIcon(icon), true);
  const store = createLoopStore();
  const { loop } = await store.create({ ...base, icon });
  assert.equal((await store.get(loop.id))!.icon, icon);
  await store.update(loop.id, { icon: "bug" });
  await store.update(loop.id, { icon });
  assert.equal((await store.get(loop.id))!.icon, icon);
  assert.equal((await store.get(loop.id))!.playbookVersion, loop.playbookVersion);
  await store.update(loop.id, { icon: null });
  assert.equal((await store.get(loop.id))!.icon, undefined);
  for (const value of [
    "https://example.com/logo.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,YWJj",
    icon + "=",
    icon + "A".repeat(65_536),
  ]) {
    assert.equal(validLoopIcon(value), false);
    await assert.rejects(store.update(loop.id, { icon: value }), /icon must/);
  }
  for (const dimension of [0, 129, 0xffffffff]) {
    const bytes = Buffer.from(icon.slice("data:image/png;base64,".length), "base64");
    bytes.writeUInt32BE(dimension, 16);
    assert.equal(validLoopIcon(`data:image/png;base64,${bytes.toString("base64")}`), false);
  }
});
