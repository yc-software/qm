import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testIdempotencyStore } from "./support/typed-stores.ts";

test("once runs fn the first time and skips on replay", async () => {
  const store = testIdempotencyStore();
  let runs = 0;
  assert.equal(await store.once("k", async () => void runs++), true);
  assert.equal(await store.once("k", async () => void runs++), false);
  assert.equal(runs, 1);
  assert.equal(await store.committed("k"), true);
});

test("a failed fn stays retryable (not committed)", async () => {
  const store = testIdempotencyStore();
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

test("durable backing: a committed key survives a restart (new store over the same database)", async () => {
  const url = testDatabaseUrl();
  const before = testIdempotencyStore({}, url);
  let runs = 0;
  await before.once("webhook:w1:d1", async () => void runs++);
  assert.equal(runs, 1);

  const after = testIdempotencyStore({}, url);
  assert.equal(await after.committed("webhook:w1:d1"), true);
  assert.equal(await after.once("webhook:w1:d1", async () => void runs++), false);
  assert.equal(runs, 1);
});

test("retention: records older than retentionMs are pruned from memory and the backing", async () => {
  const url = testDatabaseUrl();
  let t = 0;
  const store = testIdempotencyStore({ retentionMs: 100, pruneIntervalMs: 1, now: () => t }, url);
  const pg = createPgPool(url);
  const stored = async (key: string) => (await pg.q("SELECT 1 FROM idempotency WHERE key = $1", [key])).length > 0;
  t = 10;
  await store.once("old", async () => {});
  t = 500;
  await store.once("fresh", async () => {});
  for (let i = 0; i < 50 && (await stored("old")); i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(await stored("old"), false, "the stale record is swept from the backing");
  assert.equal(await stored("fresh"), true, "records inside the retention window are kept");
  assert.equal(await store.committed("old"), false);
  assert.equal(await store.committed("fresh"), true);
});

test("retention: an expired record stops deduping even before the sweep runs", async () => {
  let t = 0;
  const store = testIdempotencyStore({ retentionMs: 100, pruneIntervalMs: 10_000, now: () => t });
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
