import assert from "node:assert/strict";
import test from "node:test";
import { spendWindow } from "../../src/admin/spend.ts";

const NOW = Date.parse("2026-09-30T15:00:00.000Z");

test("spend window: a valid custom window is used as-is, in daily buckets up to 62 days and weekly beyond", () => {
  assert.deepEqual(spendWindow({ range: "7d", from: "2026-09-01", to: "2026-10-01" }, NOW), {
    from: "2026-09-01",
    to: "2026-10-01",
    preset: null,
    bucket: "day",
  });
  assert.equal(spendWindow({ from: "2026-07-01", to: "2026-09-01" }, NOW).bucket, "day");
  assert.equal(spendWindow({ from: "2026-06-30", to: "2026-09-01" }, NOW).bucket, "week");
});

test("spend window: presets end tomorrow in UTC, and impossible, empty or reversed custom windows fall back to the preset", () => {
  assert.deepEqual(spendWindow({ range: "90d" }, NOW), {
    from: "2026-07-03",
    to: "2026-10-01",
    preset: "90d",
    bucket: "week",
  });
  assert.deepEqual(spendWindow({}, NOW), { from: "2026-09-01", to: "2026-10-01", preset: "30d", bucket: "day" });
  for (const [from, to] of [
    ["2026-09-01", "2026-09-01"],
    ["2026-10-01", "2026-09-01"],
    ["2026-02-30", "2026-03-02"],
    ["2026-9-1", "2026-10-01"],
    ["2026-09-01", null],
  ]) {
    assert.deepEqual(
      spendWindow({ range: "7d", from, to }, NOW),
      { from: "2026-09-24", to: "2026-10-01", preset: "7d", bucket: "day" },
      `${from} to ${to}`,
    );
  }
});

test("spend window: unknown or inherited preset names fall back to 30d, and a custom window ends by tomorrow and spans at most 366 days", () => {
  for (const range of ["constructor", "__proto__", "toString", "1d"]) {
    assert.deepEqual(
      spendWindow({ range }, NOW),
      { from: "2026-09-01", to: "2026-10-01", preset: "30d", bucket: "day" },
      range,
    );
  }
  assert.deepEqual(spendWindow({ from: "2026-09-15", to: "2027-01-01" }, NOW), {
    from: "2026-09-15",
    to: "2026-10-01",
    preset: null,
    bucket: "day",
  });
  assert.equal(
    spendWindow({ range: "7d", from: "2026-10-01", to: "2026-11-01" }, NOW).preset,
    "7d",
    "a window starting after today falls back to the preset",
  );
  assert.deepEqual(spendWindow({ from: "0002-10-15", to: "2026-10-01" }, NOW), {
    from: "2025-09-30",
    to: "2026-10-01",
    preset: null,
    bucket: "week",
  });
  assert.equal(spendWindow({ from: "2024-01-01", to: "2025-01-01" }, NOW).from, "2024-01-01", "a leap year fits");
});
