import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cronNextFire,
  cronRunSummary,
  cronScheduleDetail,
  cronScheduleSummary,
  formatCronDateTime,
} from "../src/cron-format.ts";

const baseCron = {
  enabled: true,
  createdAt: Date.UTC(2026, 0, 1, 8),
};

test("recurring schedule detail shows first run before the first fire", () => {
  const detail = cronScheduleDetail({
    ...baseCron,
    schedule: { everyMs: 86_400_000, firstFireAt: Date.UTC(2026, 0, 2, 9) },
  });
  assert.match(detail, /^Every 1d - first run /);
});

test("recurring schedule detail stops showing stale first run after firing", () => {
  assert.equal(
    cronScheduleDetail({
      ...baseCron,
      schedule: { everyMs: 86_400_000, firstFireAt: Date.UTC(2026, 0, 2, 9) },
      lastFiredAt: Date.UTC(2026, 0, 3, 9),
    }),
    "Every 1d",
  );
});

test("one-shot schedule detail keeps the configured run time", () => {
  const detail = cronScheduleDetail({
    ...baseCron,
    enabled: false,
    schedule: { firstFireAt: Date.UTC(2026, 0, 2, 9) },
    lastFiredAt: Date.UTC(2026, 0, 2, 9),
  });
  assert.match(detail, /^One-time - run /);
});

test("calendar schedule summary and detail show the canonical expression and timezone", () => {
  const cron = {
    ...baseCron,
    schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
  };
  assert.equal(cronScheduleSummary(cron), "cron 0 9 * * 1-5");
  assert.equal(cronScheduleDetail(cron), "Cron 0 9 * * 1-5 (America/Los_Angeles)");
});

test("calendar schedule without a core-provided next fire degrades to last/never, not a bogus time", () => {
  const cron = {
    ...baseCron,
    schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
  };
  assert.equal(cronNextFire(cron), null);
  assert.equal(cronRunSummary(cron), "never fired");
  assert.match(cronRunSummary({ ...cron, lastFiredAt: Date.UTC(2026, 0, 1, 17) }), /^last /);
});

test("calendar schedule honors a core-provided next fire timestamp", () => {
  const nextFireAt = Date.UTC(2026, 0, 5, 17);
  assert.equal(
    cronNextFire({
      ...baseCron,
      nextFireAt,
      schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
    }),
    nextFireAt,
  );
});

function zonedTime(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

test("same instant renders as today's time in one timezone and tomorrow's in another", () => {
  const now = Date.UTC(2026, 6, 21, 12, 0);
  const ms = Date.UTC(2026, 6, 21, 22, 0);
  assert.equal(formatCronDateTime(ms, now, "America/Los_Angeles"), zonedTime(ms, "America/Los_Angeles"));
  assert.equal(formatCronDateTime(ms, now, "Asia/Tokyo"), `tomorrow ${zonedTime(ms, "Asia/Tokyo")}`);
});

test("tomorrow classification survives the DST spring-forward boundary", () => {
  const now = Date.UTC(2026, 2, 8, 6, 0);
  const tomorrowMs = Date.UTC(2026, 2, 8, 20, 0);
  const dayAfterMs = Date.UTC(2026, 2, 9, 20, 0);
  assert.equal(
    formatCronDateTime(tomorrowMs, now, "America/Los_Angeles"),
    `tomorrow ${zonedTime(tomorrowMs, "America/Los_Angeles")}`,
  );
  assert.doesNotMatch(formatCronDateTime(dayAfterMs, now, "America/Los_Angeles"), /^tomorrow /);
});

test("a different year in the schedule timezone includes the year", () => {
  const now = Date.UTC(2026, 6, 21, 12, 0);
  const ms = Date.UTC(2027, 6, 21, 22, 0);
  assert.match(formatCronDateTime(ms, now, "America/Los_Angeles"), /2027/);
});

test("timezone-local year decides whether the year is shown", () => {
  const now = Date.UTC(2026, 11, 20, 12, 0);
  const ms = Date.UTC(2027, 0, 1, 4, 0);
  assert.doesNotMatch(formatCronDateTime(ms, now, "America/Los_Angeles"), /202\d/);
  assert.match(formatCronDateTime(ms, now, "Asia/Tokyo"), /2027/);
});

test("an invalid timezone falls back to local-time rendering instead of throwing", () => {
  const now = Date.UTC(2026, 6, 21, 12, 0);
  const ms = Date.UTC(2026, 6, 23, 22, 0);
  assert.equal(formatCronDateTime(ms, now, "Not/AZone"), formatCronDateTime(ms, now));
});

test("an offset-style timezone TZDate parses but Intl rejects still falls back to local rendering", () => {
  const now = Date.UTC(2026, 6, 21, 12, 0);
  for (const timeZone of ["UTC+05:30", "GMT-4"]) {
    for (const ms of [now + 3_600_000, now + 26 * 3_600_000, now + 4 * 86_400_000, now + 400 * 86_400_000]) {
      assert.equal(formatCronDateTime(ms, now, timeZone), formatCronDateTime(ms, now));
    }
  }
});

function legacyFormatCronDateTime(ms: number, now: number, timeZone?: string): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (timeZone) {
    const parts = legacyZonedParts(ms, timeZone);
    const todayParts = legacyZonedParts(now, timeZone);
    if (parts && todayParts) {
      const tomorrow = legacyAddLocalDays(todayParts, 1);
      const time = zonedTime(ms, timeZone);
      if (legacySameLocalDay(parts, todayParts)) return time;
      if (legacySameLocalDay(parts, tomorrow)) return `tomorrow ${time}`;
      const dateOpts: Intl.DateTimeFormatOptions =
        parts.year === todayParts.year
          ? { month: "short", day: "numeric", timeZone }
          : { month: "short", day: "numeric", year: "numeric", timeZone };
      return `${date.toLocaleDateString([], dateOpts)} ${time}`;
    }
  }
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const time = zonedTime(ms);
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
    return time;
  if (
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  )
    return `tomorrow ${time}`;
  const dateOpts: Intl.DateTimeFormatOptions =
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${date.toLocaleDateString([], dateOpts)} ${time}`;
}

interface LegacyParts {
  year: number;
  month: number;
  day: number;
}

function legacyZonedParts(ms: number, timeZone: string): LegacyParts | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
  } catch {
    return null;
  }
}

function legacyAddLocalDays(parts: LegacyParts, days: number): LegacyParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function legacySameLocalDay(a: LegacyParts, b: LegacyParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

test("formatCronDateTime matches the legacy hand-rolled formatter across timezones, offsets, and DST boundaries", () => {
  const timeZones = [
    undefined,
    "UTC",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Australia/Lord_Howe",
    "Pacific/Chatham",
    "Not/AZone",
    "UTC+05:30",
    "GMT-4",
  ];
  const nows = [
    Date.UTC(2026, 6, 21, 18, 30),
    Date.UTC(2026, 2, 8, 9, 59),
    Date.UTC(2026, 10, 1, 8, 30),
    Date.UTC(2026, 0, 1, 2, 0),
    Date.UTC(2026, 11, 31, 23, 0),
  ];
  const offsets: number[] = [
    -400 * 86_400_000,
    -365 * 86_400_000,
    -30 * 86_400_000,
    30 * 86_400_000,
    365 * 86_400_000,
    400 * 86_400_000,
  ];
  for (let h = -72; h <= 72; h += 5) offsets.push(h * 3_600_000 + 17 * 60_000);
  for (const timeZone of timeZones) {
    for (const now of nows) {
      for (const offset of offsets) {
        const ms = now + offset;
        assert.equal(
          formatCronDateTime(ms, now, timeZone),
          legacyFormatCronDateTime(ms, now, timeZone),
          `tz=${timeZone} now=${new Date(now).toISOString()} offset=${offset}`,
        );
      }
    }
  }
});
