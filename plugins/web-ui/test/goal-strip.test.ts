import { test } from "node:test";
import assert from "node:assert/strict";
import { goalElapsedLabel, goalFloorLabel, goalObjectiveLabel, latestGoal } from "../src/goal-strip.ts";

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
        payload: { tool: "create_goal", goal: record("active", { floor: { minMs: 1_200_000 } }) },
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
    msg([{ type: "tool_result", payload: { tool: "create_goal", goal: record("active") } }]),
    msg([{ type: "tool_result", payload: { tool: "update_goal", goal: record("complete") } }]),
  ];
  assert.equal(latestGoal(closed)?.status, "complete");
  const paused = [
    msg([{ type: "tool_result", payload: { tool: "create_goal", goal: record("active") } }]),
    msg([{ type: "tool_result", payload: { tool: "update_goal", goal: record("paused") } }]),
  ];
  assert.equal(latestGoal(paused)?.status, "paused");
  const cleared = [
    msg([{ type: "tool_result", payload: { tool: "create_goal", goal: record("active") } }]),
    msg([{ type: "tool_result", payload: { tool: "get_goal", goal: null } }]),
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
