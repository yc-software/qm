import { test } from "node:test";
import assert from "node:assert/strict";
import {
  goalElapsedLabel,
  goalWorkedLabel,
  goalFloorLabel,
  goalObjectiveLabel,
  latestGoal,
} from "../src/goal-strip.ts";
import { entriesToMessages, type SessionEntry } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

function msg(activity: Array<{ type: string; payload: unknown }>): unknown {
  return { role: "assistant", work: { status: "working", activity } };
}

const record = (status: string, extra: Record<string, unknown> = {}): unknown => ({
  objective: "work for 20 minutes",
  status,
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

test("latestGoal finds the newest goal snapshot across messages", () => {
  const messages = [
    msg([
      {
        type: "tool_result",
        payload: { tool: "goal", action: "create", goal: record("active", { floor: { minMs: 1_200_000 } }) },
      },
    ]),
    msg([{ type: "tool_result", payload: { tool: "execute", ok: true } }]),
  ];
  const goal = latestGoal(messages);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.objective, "work for 20 minutes");
  assert.equal(goal?.floor, "20m");
  assert.equal(goal?.createdAt, 1000);
});

test("latestGoal reflects closure and get_goal null", () => {
  const closed = [
    msg([{ type: "tool_result", payload: { tool: "goal", goal: record("active") } }]),
    msg([{ type: "tool_result", payload: { tool: "goal", goal: record("complete") } }]),
  ];
  assert.equal(latestGoal(closed)?.status, "complete");
  const paused = [
    msg([{ type: "tool_result", payload: { tool: "goal", goal: record("active") } }]),
    msg([{ type: "tool_result", payload: { tool: "goal", goal: record("paused") } }]),
  ];
  assert.equal(latestGoal(paused)?.status, "paused");
  const cleared = [
    msg([{ type: "tool_result", payload: { tool: "goal", goal: record("active") } }]),
    msg([{ type: "tool_result", payload: { tool: "goal", goal: null } }]),
  ];
  assert.equal(latestGoal(cleared), null);
  assert.equal(latestGoal([msg([{ type: "tool_result", payload: { tool: "execute" } }])]), null);
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

test("a goal cancelled from the goal bar closes the strip and leaves one note in the transcript", () => {
  const goal = record("active");
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "work for 20 minutes" }, createdAt: 900 },
    { type: "tool_call", payload: { tool: "goal", action: "create", callId: "c1" }, createdAt: 1000 },
    { type: "tool_result", payload: { tool: "goal", action: "create", goal, callId: "c1" }, createdAt: 1001 },
    { type: "system", payload: { kind: "goal", goal: record("paused") }, createdAt: 1002 },
    { type: "assistant", payload: { text: "(stopped)", stopped: true }, createdAt: 1003 },
    { type: "system", payload: { kind: "goal", goal: record("cancelled"), cancelledBy: "U1" }, createdAt: 1004 },
  ];
  const messages = entriesToMessages(entries, MODEL);
  assert.equal(latestGoal(messages), null);
  const notes = messages.filter((m) => (m as { role?: string }).role === "system-note");
  assert.deepEqual(
    notes.map((n) => ({ ...(n as object) })),
    [{ role: "system-note", note: "goal_cancelled", content: "work for 20 minutes", timestamp: 1004 }],
  );
});

test("a goal the agent cancelled at the user's request closes the strip without a note", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "cancel the goal" }, createdAt: 900 },
    { type: "tool_result", payload: { tool: "goal", action: "create", goal: record("active") }, createdAt: 1000 },
    { type: "tool_result", payload: { tool: "goal", action: "update", goal: record("cancelled") }, createdAt: 1001 },
    { type: "system", payload: { kind: "goal", goal: record("cancelled") }, createdAt: 1002 },
    { type: "assistant", payload: { text: "Cancelled the goal." }, createdAt: 1003 },
  ];
  const messages = entriesToMessages(entries, MODEL);
  assert.equal(latestGoal(messages)?.status, "cancelled");
  assert.ok(!messages.some((m) => (m as { role?: string }).role === "system-note"));
});
