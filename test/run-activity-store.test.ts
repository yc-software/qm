import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryRunActivityStore,
  RUN_ACTIVITY_TTL_MS,
  type RunActivityEntry,
} from "../src/runs/run-activity-store.ts";

const entry = (seq: number, type = "browser_status", createdAt = 0): RunActivityEntry => ({
  seq,
  parentSeq: null,
  type,
  payload: { text: `s${seq}` },
  createdAt,
});

test("append/list preserves arrival order and isolates runs", async () => {
  const s = createMemoryRunActivityStore();
  assert.deepEqual(await s.list("r1"), [], "unknown run is empty");
  await s.append("r1", entry(1, "tool_call"));
  await s.append("r1", entry(2, "browser_status"));
  await s.append("r2", entry(1, "tool_call"));
  const r1 = await s.list("r1");
  assert.deepEqual(
    r1.map((e) => e.type),
    ["tool_call", "browser_status"],
    "arrival order preserved",
  );
  assert.equal((await s.list("r2")).length, 1, "runs are isolated");
});

test("list returns a copy — mutating it can't corrupt the store", async () => {
  const s = createMemoryRunActivityStore();
  await s.append("r1", entry(1));
  (await s.list("r1")).push(entry(99));
  assert.equal((await s.list("r1")).length, 1);
});

test("prunes a run's feed once its entries age past the TTL", async () => {
  let now = 1_000_000;
  const s = createMemoryRunActivityStore(() => now);
  await s.append("old", entry(1, "browser_status", now));
  assert.equal((await s.list("old")).length, 1);
  now += RUN_ACTIVITY_TTL_MS + 120_000;
  await s.append("fresh", entry(1, "browser_status", now));
  assert.equal((await s.list("old")).length, 0, "the stale run's feed was pruned");
  assert.equal((await s.list("fresh")).length, 1, "the fresh entry survives");
});
