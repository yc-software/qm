// LAB-185: a goal the governor never pauses still stops after 4 hours of active work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoalRecord, enforceGoal, goalPausedNote } from "../src/harness/goal.ts";
import { createGrindMeter } from "../src/harness/grind.ts";

const H = 3_600_000;

test("an always-continue goal pauses to check in after 4h of active work", async () => {
  let t = 1_000_000;
  const goal = createGoalRecord({ objective: "impossible", now: t });
  const meter = createGrindMeter(t);
  const notes: string[] = [];
  let governed = 0;
  const outcome = await enforceGoal({
    goal,
    meter,
    outcome: "ok",
    ok: "ok",
    now: () => t,
    blocked: () => notes.length > 10_000, // safety valve; on main the loop never ends on its own
    beforePrompt: () => {},
    govern: async () => (governed++, { verdict: "continue", reasons: "not done" }),
    prompt: async (note) => {
      notes.push(note);
      t += 20 * 60_000;
      return "ok";
    },
  });
  assert.equal(outcome, "ok");
  assert.equal(goal.status, "paused");
  assert.ok(t - 1_000_000 >= 4 * H && t - 1_000_000 < 4 * H + 40 * 60_000, `paused after ${(t - 1_000_000) / H}h`);
  assert.match(notes.at(-1)!, /4 hours of active work\. Should I keep going\?/);
  assert.match(goalPausedNote(goal), /waiting_on>\nThis goal has had 4 hours/);
  assert.ok(governed > 0);
});

test("after the user resumes, it runs another 4h (banked time is not re-counted)", async () => {
  let t = 1_000_000;
  const goal = createGoalRecord({ objective: "impossible", now: t });
  goal.activeMs = 4.5 * H; // banked across earlier turns, already checked in once
  const meter = createGrindMeter(t);
  let rounds = 0;
  await enforceGoal({
    goal,
    meter,
    outcome: "ok",
    ok: "ok",
    now: () => t,
    blocked: () => rounds > 10_000,
    beforePrompt: () => {},
    prompt: async () => {
      rounds++;
      t += 20 * 60_000;
      return "ok";
    },
  });
  assert.equal(goal.status, "paused");
  assert.ok(t - 1_000_000 >= 3.5 * H && t - 1_000_000 <= 4 * H, `paused after ${(t - 1_000_000) / H}h more`);
});
