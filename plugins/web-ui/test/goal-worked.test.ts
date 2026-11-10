import { item } from "./item-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { goalWorked } from "../src/work-duration.ts";

const MIN = 60_000;
const goal = {
  objective: "grind 20m",
  status: "active",
  floor: { minMs: 20 * MIN },
  createdAt: 2 * MIN,
  updatedAt: 2 * MIN,
};
const turn = (
  startedAt: number,
  finishedAt: number,
  extra: Record<string, unknown> = {},
  activity: unknown[] = [],
) => ({
  role: "assistant",
  work: { status: "complete", startedAt, finishedAt, activity },
  ...extra,
});
const strip = { objective: goal.objective, status: "active" as const, createdAt: goal.createdAt };
const created = [item("ToolResult", { createdAt: 2 * MIN, tool: "goal", body: { action: "create", goal } })];

test("worked time counts only running turns: idle and paused intervals are excluded", () => {
  const messages = [
    turn(0, MIN),
    turn(MIN, 10 * MIN, {}, created),
    turn(10 * MIN, 12 * MIN, { stopReason: "aborted" }),
    turn(40 * MIN, 45 * MIN),
  ];
  assert.equal(goalWorked(messages.slice(0, 2), strip), 8 * MIN);
  assert.equal(goalWorked(messages.slice(0, 3), strip), 10 * MIN);
  assert.equal(goalWorked(messages, strip), 15 * MIN, "a turn after a stop keeps adding to the tally");
});

test("a resumed goal adds the new turn but not the gap before it", () => {
  const messages = [turn(MIN, 10 * MIN, {}, created), turn(30 * MIN, 35 * MIN), turn(90 * MIN, 91 * MIN)];
  assert.equal(goalWorked(messages, strip), 14 * MIN);
});
