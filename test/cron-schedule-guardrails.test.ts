import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule, validateUserSchedule } from "../src/cron/schedule.ts";

const now = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

test("rejects a daily (24h) everyMs interval, steering to {cron,timezone}", () => {
  assert.throws(() => normalizeSchedule({ everyMs: DAY }, now), /clock-time schedule in disguise|cron,timezone/);
});

test("rejects a weekly everyMs interval", () => {
  assert.throws(() => normalizeSchedule({ everyMs: 7 * DAY }, now), /everyMs/);
});

test("rejects recurring schedules faster than once a minute", () => {
  assert.throws(() => validateUserSchedule({ everyMs: 59_999 }), /at least 60000ms/);
});

test("allows a sub-day polling interval", () => {
  const r = normalizeSchedule({ everyMs: 15 * 60 * 1000 }, now);
  assert.equal(r.schedule.everyMs, 15 * 60 * 1000);
  assert.equal(r.nextFireAt, now + 15 * 60 * 1000);
});

test("allows an interval just under 24h", () => {
  const r = normalizeSchedule({ everyMs: DAY - 1 }, now);
  assert.equal(r.schedule.everyMs, DAY - 1);
});

test("a calendar schedule with timezone is unaffected", () => {
  const r = normalizeSchedule({ cron: "30 7 * * 1-5", timezone: "America/Los_Angeles" }, now);
  assert.equal(r.schedule.cron, "30 7 * * 1-5");
  assert.equal(r.schedule.timezone, "America/Los_Angeles");
  assert.ok(r.nextFireAt && r.nextFireAt > now);
});
