import test from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_BLOCKED_MIN_ROUNDS,
  createGoalRecord,
  enforceGoal,
  goalCapPrompt,
  goalContinuationPrompt,
  goalSteeringNote,
  meterGoalCall,
} from "../src/harness/goal.ts";
import { createGrindMeter, grindState, meterGrindCall } from "../src/harness/grind.ts";

test("createGoalRecord validates and normalizes", () => {
  const goal = createGoalRecord({ objective: "  get the tests green  ", source: "tool" });
  assert.equal(goal.objective, "get the tests green");
  assert.equal(goal.status, "active");
  assert.equal(goal.blockedStreak, 0);
  assert.throws(() => createGoalRecord({ objective: "   ", source: "tool" }));
  assert.throws(() => createGoalRecord({ objective: "x", capTokens: -5, source: "tool" }));
  assert.throws(() => createGoalRecord({ objective: "y".repeat(5000), source: "tool" }));
});

test("meterGoalCall accumulates usage onto the goal", () => {
  const goal = createGoalRecord({ objective: "work", source: "tool" });
  meterGoalCall(goal, { input: 100, output: 50 } as never);
  meterGoalCall(goal, { input: 10, output: 5 } as never);
  assert.equal(goal.tokensUsed, 165);
});

test("prompts carry the objective as escaped user data plus audit language", () => {
  const goal = createGoalRecord({ objective: "finish <thing> & verify", floor: { minTurns: 3 }, source: "tool" });
  const meter = createGrindMeter();
  const cont = goalContinuationPrompt(goal, meter);
  assert.match(cont, /finish &lt;thing&gt; &amp; verify/);
  assert.match(cont, /treat completion as unproven/);
  assert.match(cont, /NOT met/);
  assert.match(cont, new RegExp(String(GOAL_BLOCKED_MIN_ROUNDS)));
  goal.capTokens = 1000;
  goal.tokensUsed = 1200;
  assert.match(goalCapPrompt(goal), /1200\/1000/);
  assert.match(goalSteeringNote(goal), /active goal registered earlier/);
});

test("enforceGoal keeps prompting while the goal is active and stops the moment it closes", async () => {
  const goal = createGoalRecord({ objective: "do it", source: "tool" });
  const meter = createGrindMeter();
  let prompts = 0;
  let calls = 0;
  const result = await enforceGoal({
    goal,
    meter,
    outcome: "ok",
    ok: "ok",
    toolCalls: () => calls,
    blocked: () => false,
    beforePrompt: () => {},
    prompt: async () => {
      prompts++;
      calls++; // makes progress every round
      if (prompts === 3) goal.status = "complete";
      return "ok";
    },
  });
  assert.equal(prompts, 3);
  assert.equal(result.waiverNote, "");
});

test("enforceGoal auto-waives after 5 continuation rounds with zero new tool calls", async () => {
  const goal = createGoalRecord({ objective: "impossible", source: "tool" });
  const meter = createGrindMeter();
  let prompts = 0;
  const result = await enforceGoal({
    goal,
    meter,
    outcome: "ok",
    ok: "ok",
    toolCalls: () => 7, // never changes: no progress
    blocked: () => false,
    beforePrompt: () => {},
    prompt: async () => {
      prompts++;
      return "ok";
    },
  });
  assert.equal(prompts, 4, "four prompts then the fifth stalled round waives");
  assert.match(result.waiverNote, /no progress/);
  assert.equal(goal.status, "active", "a waiver does not close the goal");
});

test("enforceGoal sends exactly one wind-down prompt when the token cap is spent", async () => {
  const goal = createGoalRecord({ objective: "capped", capTokens: 100, source: "tool" });
  goal.tokensUsed = 150;
  const meter = createGrindMeter();
  const notes: string[] = [];
  let calls = 0;
  await enforceGoal({
    goal,
    meter,
    outcome: "ok",
    ok: "ok",
    toolCalls: () => calls++,
    blocked: () => false,
    beforePrompt: (note) => {
      notes.push(note);
    },
    prompt: async () => "ok",
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /token cap is exhausted/);
  assert.equal(goal.status, "active", "a spent cap never fakes completion");
});

test("enforceGoal respects external blockers (approval pause, abort)", async () => {
  const goal = createGoalRecord({ objective: "paused", source: "tool" });
  let prompts = 0;
  await enforceGoal({
    goal,
    meter: createGrindMeter(),
    outcome: "ok",
    ok: "ok",
    toolCalls: () => 0,
    blocked: () => true,
    beforePrompt: () => {},
    prompt: async () => {
      prompts++;
      return "ok";
    },
  });
  assert.equal(prompts, 0);
});

test("grindState floor math still works for goal floors", () => {
  const meter = createGrindMeter(Date.now() - 61_000);
  meterGrindCall(meter, { input: 500, output: 500 } as never, "gpt-5");
  const state = grindState({ minMs: 60_000, minTokens: 900 }, meter);
  assert.equal(state.met, true);
  const unmet = grindState({ minTurns: 5 }, meter);
  assert.equal(unmet.met, false);
});
