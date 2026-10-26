import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { goalElapsedLabel, goalWorkedLabel, goalFloorLabel, goalObjectiveLabel } from "../src/goal-strip.ts";
import { itemsToMessages } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<typeof itemsToMessages>[1];

const record = (status: string, extra: Record<string, unknown> = {}): unknown => ({
  objective: "work for 20 minutes",
  status,
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

test("labels: elapsed, floor, objective trim", () => {
  assert.equal(goalElapsedLabel(0, 3_000), "3s");
  assert.equal(goalElapsedLabel(0, 90_000), "1m 30s");
  assert.equal(goalElapsedLabel(0, 3_600_000), "1h");
  assert.equal(goalFloorLabel({ minTurns: 5, minTokens: 2000 }), "5 turns, 2,000 tokens");
  assert.equal(goalFloorLabel(null), null);
  assert.equal(goalObjectiveLabel("a\nb\tc"), "a b c");
  assert.equal(goalObjectiveLabel("x".repeat(200)).length, 120);
});

test("worked time leads the label, the floor follows", () => {
  assert.equal(goalWorkedLabel(720_000, "20m"), "12m worked · 20m floor");
  assert.equal(goalWorkedLabel(45_000), "45s worked");
});

test("a goal cancelled from the goal bar leaves one note in the transcript", () => {
  const goal = record("active");
  const items: Item[] = [
    item("UserMessage", { createdAt: 900, text: "work for 20 minutes" }),
    item("ToolCall", { createdAt: 1000, tool: "goal", callId: "c1", body: { action: "create" } }),
    item("ToolResult", { createdAt: 1001, tool: "goal", callId: "c1", body: { action: "create", goal } }),
    item("AgentMessage", { createdAt: 1003, text: "(stopped)", body: { stopped: true } }),
    item("Wake", {
      createdAt: 1004,
      wakeCause: "system",
      body: { kind: "goal_cancelled", objective: "work for 20 minutes", cancelledBy: "U1" },
    }),
  ];
  const messages = itemsToMessages(items, MODEL);
  const notes = messages.filter((m) => (m as { role?: string }).role === "system-note");
  assert.deepEqual(
    notes.map((n) => ({ ...(n as object) })),
    [{ role: "system-note", note: "goal_cancelled", content: "work for 20 minutes", timestamp: 1004 }],
  );
});
