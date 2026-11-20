import assert from "node:assert/strict";
import test from "node:test";
import type { CalendarEvent } from "../src/calendar-api.ts";
import { dayBlocks, eventSpan, laneBars, visibleDays } from "../src/calendar-layout.ts";

const event = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id,
  calendarId: "c",
  title: id,
  start,
  end,
  allDay,
  htmlLink: "",
  color: "#039be5",
  attendees: [],
  editable: true,
});

test("week and month ranges start on the week's first day and cover whole weeks", () => {
  const week = visibleDays("week", new Date(2026, 10, 20));
  assert.deepEqual([week.length, week[0]!.getDate(), week[6]!.getDate()], [7, 15, 21]);
  const month = visibleDays("month", new Date(2026, 10, 20));
  assert.deepEqual([month.length, month[0]!.getDate(), month.at(-1)!.getDate()], [35, 1, 5]);
});

test("overlapping events share a day side by side and free columns are reused", () => {
  const day = new Date(2026, 10, 20);
  const blocks = dayBlocks(
    [
      event("a", "2026-11-20T10:00:00", "2026-11-20T11:00:00"),
      event("b", "2026-11-20T10:30:00", "2026-11-20T11:30:00"),
      event("c", "2026-11-20T13:00:00", "2026-11-20T14:00:00"),
      event("all", "2026-11-20", "2026-11-21", true),
    ].map(eventSpan),
    day,
  );
  assert.deepEqual(
    blocks.map((block) => [block.event.id, block.top, block.col, block.cols, block.width]),
    [
      ["a", 600, 0, 2, 1],
      ["b", 630, 1, 2, 1],
      ["c", 780, 0, 1, 1],
    ],
  );
});

test("multi-day events take lanes clipped to the visible days", () => {
  const days = visibleDays("week", new Date(2026, 10, 20));
  const bars = laneBars(
    [event("trip", "2026-11-13", "2026-11-17", true), event("offsite", "2026-11-16", "2026-11-19", true)].map(
      eventSpan,
    ),
    days,
  );
  assert.deepEqual(
    bars.map((bar) => [bar.event.id, bar.col, bar.span, bar.lane, bar.clippedStart]),
    [
      ["trip", 0, 2, 0, true],
      ["offsite", 1, 3, 1, false],
    ],
  );
});
