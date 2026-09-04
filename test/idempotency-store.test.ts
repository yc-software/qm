import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyStore, type IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("once runs fn the first time and skips on replay (in-memory)", async () => {
  const store = createIdempotencyStore();
  let runs = 0;
  assert.equal(await store.once("k", async () => void runs++), true);
  assert.equal(await store.once("k", async () => void runs++), false);
  assert.equal(runs, 1);
  assert.equal(await store.committed("k"), true);
});

test("a failed fn stays retryable (not committed)", async () => {
  const store = createIdempotencyStore();
  await assert.rejects(
    store.once("k", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await store.committed("k"), false);
  let ran = false;
  assert.equal(await store.once("k", async () => void (ran = true)), true);
  assert.equal(ran, true);
});

test("durable backing: a committed key survives a restart (new store over the same map)", async () => {
  const backing = createMemoryMap<IdempotencyRecord>();
  const before = createIdempotencyStore(backing);
  let runs = 0;
  await before.once("webhook:w1:d1", async () => void runs++);
  assert.equal(runs, 1);

  const after = createIdempotencyStore(backing);
  assert.equal(await after.committed("webhook:w1:d1"), true);
  assert.equal(await after.once("webhook:w1:d1", async () => void runs++), false);
  assert.equal(runs, 1);
});

test("lookups are point reads — committed() never scans the whole table into RAM", async () => {
  const inner = createMemoryMap<IdempotencyRecord>();
  let allCalls = 0;
  const backing = {
    ...inner,
    all: async () => {
      allCalls++;
      return inner.all();
    },
  };
  await inner.put("k1", { key: "k1", at: Date.now() });
  const store = createIdempotencyStore(backing);
  assert.equal(await store.committed("k1"), true);
  assert.equal(await store.committed("nope"), false);
  let ran = 0;
  await store.once("k2", async () => void ran++);
  assert.equal(ran, 1);
  assert.equal(allCalls, 0, "no full-table seed on boot or lookup");
});

test("retention: records older than retentionMs are pruned from memory and the backing", async () => {
  const backing = createMemoryMap<IdempotencyRecord>();
  let t = 0;
  const store = createIdempotencyStore(backing, { retentionMs: 100, pruneIntervalMs: 1, now: () => t });
  t = 10;
  await store.once("old", async () => {});
  t = 500;
  await store.once("fresh", async () => {});
  for (let i = 0; i < 50 && (await backing.get("old")) != null; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(await backing.get("old"), null, "the stale record is swept from the backing");
  assert.ok(await backing.get("fresh"), "records inside the retention window are kept");
  assert.equal(await store.committed("old"), false);
  assert.equal(await store.committed("fresh"), true);
});

test("retention: an expired record stops deduping even before the sweep runs", async () => {
  const backing = createMemoryMap<IdempotencyRecord>();
  let t = 0;
  const store = createIdempotencyStore(backing, { retentionMs: 100, pruneIntervalMs: 10_000, now: () => t });
  t = 10;
  await store.once("k", async () => {});
  t = 50;
  assert.equal(await store.committed("k"), true);
  t = 200;
  assert.equal(await store.committed("k"), false, "lookups honor the cutoff, not the sweep schedule");
  let ran = 0;
  assert.equal(await store.once("k", async () => void ran++), true, "an expired key is replayable again");
  assert.equal(ran, 1);
});
