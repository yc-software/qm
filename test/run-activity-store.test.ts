import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryRunActivityStore,
  RUN_ACTIVITY_TTL_MS,
  type RunActivityEntry,
} from "../src/runs/run-activity-store.ts";
import { storedItem } from "../src/sessions/items.ts";

const entry = (seq: number, kind: "status" | "tool" = "status", createdAt = 0): RunActivityEntry =>
  kind === "tool"
    ? { item: storedItem({ kind: "ToolCall", tool: "execute", callId: `c${seq}` }, { sessionId: "s", seq, createdAt }) }
    : { marker: "sandbox_status", seq, createdAt, text: `s${seq}` };

test("append/list preserves arrival order and isolates runs", async () => {
  const s = createMemoryRunActivityStore();
  assert.deepEqual(await s.list("r1"), [], "unknown run is empty");
  await s.append("r1", entry(1, "tool"));
  await s.append("r1", entry(2, "status"));
  await s.append("r2", entry(1, "tool"));
  const r1 = await s.list("r1");
  assert.deepEqual(
    r1.map((e) => ("item" in e ? e.item.kind : e.marker)),
    ["ToolCall", "sandbox_status"],
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
  await s.append("old", entry(1, "status", now));
  assert.equal((await s.list("old")).length, 1);
  now += RUN_ACTIVITY_TTL_MS + 120_000;
  await s.append("fresh", entry(1, "status", now));
  assert.equal((await s.list("old")).length, 0, "the stale run's feed was pruned");
  assert.equal((await s.list("fresh")).length, 1, "the fresh entry survives");
});
