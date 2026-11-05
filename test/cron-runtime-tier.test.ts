import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeChoice, turnModelOptions } from "../src/agent/runtime-choice.ts";
import { turnRuntimePurpose } from "../src/core/turn-options.ts";
import { firesAtMostDaily } from "../src/cron/schedule.ts";
import type { RuntimeChoice } from "../src/agent/agent.ts";
import type { CronSchedule } from "../src/triggers/types.ts";
import { testConfigStore } from "./support/test-database.ts";

const ORG = "org:default-org";
const SCOPE = "personal:alice";
const fallback: RuntimeChoice = { modelId: "claude-opus-5" };
const chat: RuntimeChoice = { modelId: "claude-opus-5", effortLevel: "high", fastMode: true };
const cronSetting: RuntimeChoice = { modelId: "claude-sonnet-5", effortLevel: "low" };
const pin: RuntimeChoice = { modelId: "gpt-6-luna", effortLevel: "medium", fastMode: false };
const tz = "America/Los_Angeles";
const now = Date.parse("2026-11-04T18:00:00-08:00");

const daily: CronSchedule = { cron: "0 9 * * *", timezone: tz };
const weekdays: CronSchedule = { cron: "0 9 * * 1-5", timezone: tz };
const twiceDaily: CronSchedule = { cron: "0 9,17 * * *", timezone: tz };
const interval: CronSchedule = { everyMs: 15 * 60_000, firstFireAt: now };
const oneShot: CronSchedule = { firstFireAt: now };

test("only schedules firing at most once a day on average are infrequent", () => {
  assert.equal(firesAtMostDaily(daily, now), true);
  assert.equal(firesAtMostDaily(weekdays, now), true);
  assert.equal(firesAtMostDaily({ cron: "0 9 1 * *", timezone: tz }, now), true);
  assert.equal(firesAtMostDaily(oneShot, now), true);
  assert.equal(firesAtMostDaily(twiceDaily, now), false);
  assert.equal(firesAtMostDaily(interval, now), false);
  assert.equal(firesAtMostDaily({ everyMs: 23 * 3600_000 }, now), false);
});

test("a daily cron firing exactly at its scheduled time still counts seven fires a week", () => {
  const nineAm = Date.parse("2026-11-05T09:00:00-08:00");
  assert.equal(firesAtMostDaily(daily, nineAm), true);
  assert.equal(firesAtMostDaily({ cron: "0 9 * * *,0", timezone: tz }, nineAm), true);
  assert.equal(firesAtMostDaily({ cron: "0 9,10 * * 0", timezone: tz }, nineAm), true);
  assert.equal(firesAtMostDaily({ cron: "0 9,10 * * 0-3", timezone: tz }, nineAm), false);
});

async function setup() {
  const config = testConfigStore("default-org");
  await config.setRuntimeSelection(ORG, chat);
  await config.setPurposeRuntime("cron", cronSetting);
  return config;
}

// Mirrors the fire path: run-trigger's turnModelOptions, then runtime resolution with the turn's purpose.
async function cronTurnRuntime(
  config: ReturnType<typeof testConfigStore>,
  schedule: CronSchedule,
  runtime?: RuntimeChoice,
): Promise<RuntimeChoice> {
  const turn = { triggered: true, surface: "cron", infrequentCron: firesAtMostDaily(schedule, now) };
  const options = turnModelOptions({
    ...turn,
    ...(runtime?.effortLevel ? { thinkingLevel: runtime.effortLevel } : {}),
    ...(typeof runtime?.fastMode === "boolean" ? { fastMode: runtime.fastMode } : {}),
  });
  const requested = {
    ...(runtime ? { modelId: runtime.modelId } : {}),
    ...(options.thinkingLevel ? { effortLevel: options.thinkingLevel } : {}),
    ...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
  };
  return resolveRuntimeChoice(config, ORG, SCOPE, fallback, requested, undefined, turnRuntimePurpose(turn));
}

test("infrequent crons run on the chat default with fast mode off", async () => {
  const config = await setup();
  for (const schedule of [daily, weekdays, oneShot])
    assert.deepEqual(await cronTurnRuntime(config, schedule), { ...chat, fastMode: false });
});

test("infrequent crons follow the owner scope's chat setting", async () => {
  const config = await setup();
  await config.setRuntimeSelection(SCOPE, { modelId: "claude-sonnet-5", effortLevel: "medium" });
  assert.deepEqual(await cronTurnRuntime(config, daily), {
    modelId: "claude-sonnet-5",
    effortLevel: "medium",
    fastMode: false,
  });
});

test("frequent crons keep the org cron setting", async () => {
  const config = await setup();
  for (const schedule of [twiceDaily, interval]) assert.deepEqual(await cronTurnRuntime(config, schedule), cronSetting);
});

test("a pinned cron runtime wins in both tiers", async () => {
  const config = await setup();
  for (const schedule of [daily, weekdays, oneShot, twiceDaily, interval])
    assert.deepEqual(await cronTurnRuntime(config, schedule, pin), pin);
});

test("loops and cron-spawned subagents keep their purposes", () => {
  assert.equal(turnRuntimePurpose({ triggered: true, surface: "loop", infrequentCron: true }), "cron");
  assert.equal(turnRuntimePurpose({ triggered: true, surface: "cron", infrequentCron: true }, true), "subagent");
  assert.equal(turnRuntimePurpose({ triggered: false, surface: "cron", infrequentCron: true }), undefined);
  assert.deepEqual(turnModelOptions({ triggered: true, surface: "loop", infrequentCron: true }), {});
});
