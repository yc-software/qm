import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunActivityEntry } from "../src/runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "../src/runs/postgres-run-activity-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const entry = (seq: number, type = "browser_status", createdAt = 0): RunActivityEntry => ({
  seq,
  parentSeq: null,
  type,
  payload: { text: `s${seq}` },
  createdAt,
});

test("append/list preserves arrival order and isolates runs", async () => {
  const s = createPostgresRunActivityStore(testDatabaseUrl());
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
  const s = createPostgresRunActivityStore(testDatabaseUrl());
  await s.append("r1", entry(1));
  (await s.list("r1")).push(entry(99));
  assert.equal((await s.list("r1")).length, 1);
});
