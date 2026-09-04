import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunActivityStore } from "../src/runs/postgres-run-activity-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the pg run-activity tests";

test("pg store: activity written by one instance is readable by another, in arrival order", { skip }, async () => {
  const writer = createPostgresRunActivityStore(URL!);
  const reader = createPostgresRunActivityStore(URL!);
  const runId = `test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writer.append(runId, {
      seq: 1,
      parentSeq: null,
      type: "tool_call",
      payload: { tool: "execute" },
      createdAt: 1,
    });
    await writer.append(runId, {
      seq: 1_000_000,
      parentSeq: null,
      type: "browser_status",
      payload: { text: "Step 1" },
      createdAt: 2,
    });
    await writer.append(runId, { seq: 2, parentSeq: 1, type: "tool_result", payload: { code: 0 }, createdAt: 3 });

    const got = await reader.list(runId);
    assert.deepEqual(
      got.map((e) => e.type),
      ["tool_call", "browser_status", "tool_result"],
      "arrival order is preserved across instances (browse status interleaves between call and result)",
    );
    assert.deepEqual(got[1]!.payload, { text: "Step 1" }, "jsonb payload round-trips decoded");
    assert.equal(got[2]!.parentSeq, 1, "parent_seq round-trips");
    assert.deepEqual(await reader.list("no-such-run"), [], "unknown run is empty");
  } finally {
    await writer.close?.();
    await reader.close?.();
  }
});
