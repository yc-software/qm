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
  const at = (seq: number) => ({ sessionId: "s", seq, createdAt: seq });
  const call = storedItem({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "ls" } }, at(1));
  const result = storedItem(
    { kind: "ToolResult", tool: "execute", callId: "c1", text: "ok", body: { code: 0 } },
    at(3),
  );
  try {
    await writer.append(runId, { item: call });
    await writer.append(runId, {
      marker: "text_start",
      seq: 1_000_000,
      createdAt: 2,
      phase: "commentary",
      streamOffset: 4,
    });
    await writer.append(runId, { item: result });

    const got = await reader.list(runId);
    assert.deepEqual(
      got.map((e) => ("item" in e ? e.item.kind : e.marker)),
      ["ToolCall", "text_start", "ToolResult"],
      "arrival order is preserved across instances (a text block start interleaves between call and result)",
    );
    assert.deepEqual(got[0], { item: call }, "items round-trip decoded");
    assert.deepEqual(
      got[1],
      { marker: "text_start", seq: 1_000_000, createdAt: 2, phase: "commentary", streamOffset: 4 },
      "text_start markers keep their phase and stream offset",
    );
    assert.deepEqual(got[2], { item: result });
    assert.deepEqual(await reader.list("no-such-run"), [], "unknown run is empty");
  } finally {
    await writer.close?.();
    await reader.close?.();
  }
});
