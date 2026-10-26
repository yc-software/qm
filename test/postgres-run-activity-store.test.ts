import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunActivityStore } from "../src/runs/postgres-run-activity-store.ts";
import { storedItem } from "../src/sessions/items.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the pg run-activity tests";

test("pg store: activity written by one instance is readable by another, in arrival order", { skip }, async () => {
  const writer = createPostgresRunActivityStore(URL!);
  const reader = createPostgresRunActivityStore(URL!);
  const runId = `test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const at = (seq: number, createdAt: number) => ({ sessionId: "s1", seq, createdAt });
  try {
    await writer.append(runId, { item: storedItem({ kind: "ToolCall", tool: "execute", callId: "c1" }, at(1, 1)) });
    await writer.append(runId, { marker: "sandbox_status", seq: 1_000_000, createdAt: 2, text: "Step 1" });
    const result = storedItem({ kind: "ToolResult", tool: "execute", callId: "c1", body: { code: 0 } }, at(2, 3));
    await writer.append(runId, { item: result });

    const got = await reader.list(runId);
    assert.deepEqual(
      got.map((e) => ("item" in e ? e.item.kind : e.marker)),
      ["ToolCall", "sandbox_status", "ToolResult"],
      "arrival order is preserved across instances (status markers interleave between call and result)",
    );
    assert.deepEqual(got[1], { marker: "sandbox_status", seq: 1_000_000, createdAt: 2, text: "Step 1" });
    assert.deepEqual(got[2], { item: result }, "jsonb item round-trips decoded");
    assert.deepEqual(await reader.list("no-such-run"), [], "unknown run is empty");
  } finally {
    await writer.close?.();
    await reader.close?.();
  }
});
