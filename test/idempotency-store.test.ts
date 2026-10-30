import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";

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

test("retention: an expired record stops deduping even before the sweep runs", async () => {
  let t = 0;
  const store = createIdempotencyStore({ retentionMs: 100, pruneIntervalMs: 10_000, now: () => t });
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
