import { test } from "node:test";
import assert from "node:assert/strict";
import { startStallWatchdog } from "../src/core/orchestrator/stall-watchdog.ts";
import { wallClockTurnFailure } from "../src/agent/agent-run.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a turn making no progress trips the stall bound exactly once", async () => {
  let stalled = 0;
  const watchdog = startStallWatchdog(20, () => stalled++);
  await wait(80);
  assert.equal(stalled, 1, "the abort fires exactly once");
  watchdog.stop();
});

test("turn progress keeps a turn alive past the stall bound", async () => {
  let stalled = 0;
  const watchdog = startStallWatchdog(40, () => stalled++);
  const feeder = setInterval(() => watchdog.progress(), 5);
  await wait(150);
  clearInterval(feeder);
  assert.equal(stalled, 0, "a progressing turn is never aborted");
  await wait(80);
  assert.equal(stalled, 1, "once progress stops, the bound trips");
  watchdog.stop();
});

test("a stopped watchdog never fires", async () => {
  let stalled = 0;
  const watchdog = startStallWatchdog(20, () => stalled++);
  watchdog.stop();
  await wait(60);
  assert.equal(stalled, 0);
});

test("wall-clock failure survives a cancel only for abandoned turns", () => {
  assert.equal(wallClockTurnFailure("ok", false, false), false);
  assert.equal(wallClockTurnFailure("ok", false, true), false);
  assert.equal(wallClockTurnFailure("aborted", false, false), true);
  assert.equal(wallClockTurnFailure("aborted", true, false), false);
  assert.equal(wallClockTurnFailure("aborted", false, true), false);
  assert.equal(wallClockTurnFailure("abandoned", false, true), true);
  assert.equal(wallClockTurnFailure("abandoned", false, false), true);
});
