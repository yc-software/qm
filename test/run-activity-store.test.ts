import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunActivityEntry } from "../src/runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "../src/runs/postgres-run-activity-store.ts";
import { storedItem } from "../src/sessions/items.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const toolCall = (seq: number): RunActivityEntry => ({
  item: storedItem({ kind: "ToolCall", tool: "execute", callId: `c${seq}` }, { sessionId: "s", seq, createdAt: 0 }),
});
const textStart = (seq: number): RunActivityEntry => ({ marker: "text_start", seq, createdAt: 0 });
const label = (entry: RunActivityEntry) => ("item" in entry ? entry.item.kind : entry.marker);

test("append/list preserves arrival order and isolates runs", async () => {
  const s = createPostgresRunActivityStore(testDatabaseUrl());
  assert.deepEqual(await s.list("r1"), [], "unknown run is empty");
  await s.append("r1", toolCall(1));
  await s.append("r1", textStart(2));
  await s.append("r2", toolCall(1));
  const r1 = await s.list("r1");
  assert.deepEqual(r1.map(label), ["ToolCall", "text_start"], "arrival order preserved");
  assert.equal((await s.list("r2")).length, 1, "runs are isolated");
});

test("list returns a copy — mutating it can't corrupt the store", async () => {
  const s = createPostgresRunActivityStore(testDatabaseUrl());
  await s.append("r1", toolCall(1));
  (await s.list("r1")).push(toolCall(99));
  assert.equal((await s.list("r1")).length, 1);
});
