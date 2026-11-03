import { test } from "node:test";
import assert from "node:assert/strict";
import { startStallWatchdog } from "../src/core/orchestrator/stall-watchdog.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a turn making no progress trips the stall bound exactly once", async () => {
  let stalled = 0;
  const watchdog = startStallWatchdog(100, () => stalled++);
  await wait(400);
  assert.equal(stalled, 1, "the abort fires exactly once");
  watchdog.progress();
  await wait(400);
  assert.equal(stalled, 1, "progress after the abort does not re-arm it");
  watchdog.stop();
});

test("turn progress keeps a turn alive past the stall bound", async () => {
  let stalled = 0;
  const watchdog = startStallWatchdog(500, () => stalled++);
  const feeder = setInterval(() => watchdog.progress(), 10);
  await wait(700);
  clearInterval(feeder);
  assert.equal(stalled, 0, "a progressing turn is never aborted");
  await wait(600);
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
