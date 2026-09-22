import assert from "node:assert/strict";
import test from "node:test";
import { formatMessageTime } from "../src/message-time.ts";

const now = new Date(2026, 8, 21, 19, 13).getTime();
const clock = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

for (const [label, date, options] of [
  ["today", new Date(2026, 8, 21, 11, 55), null],
  ["yesterday", new Date(2026, 8, 20, 23, 55), { weekday: "long" }],
  ["Friday in the screenshot", new Date(2026, 8, 18, 23, 55), { weekday: "long" }],
  ["six calendar days ago", new Date(2026, 8, 15), { weekday: "long" }],
  ["a week ago", new Date(2026, 8, 14, 23, 55), { month: "short", day: "numeric" }],
  ["last year", new Date(2025, 8, 18, 23, 55), { month: "short", day: "numeric", year: "numeric" }],
  ["a future day", new Date(2026, 8, 22, 11, 55), { month: "short", day: "numeric" }],
] as const) {
  test(`message time includes the right date for ${label}`, () => {
    const prefix = options ? `${date.toLocaleDateString([], options)} ` : "";
    assert.equal(formatMessageTime(date.getTime(), now), `${prefix}${clock(date)}`);
  });
}

test("date labels change at local midnight, not after 24 hours", () => {
  const date = new Date(2026, 8, 20, 23, 55);
  const prefix = date.toLocaleDateString([], { weekday: "long" });
  assert.equal(formatMessageTime(date.getTime(), new Date(2026, 8, 21, 0, 1).getTime()), `${prefix} ${clock(date)}`);
});

test("weekday window uses calendar days across daylight saving changes", () => {
  for (const [today, date] of [
    [new Date(2026, 2, 10, 12), new Date(2026, 2, 4)],
    [new Date(2026, 10, 3, 12), new Date(2026, 9, 28)],
  ]) {
    assert.equal(
      formatMessageTime(date.getTime(), today.getTime()),
      `${date.toLocaleDateString([], { weekday: "long" })} ${clock(date)}`,
    );
  }
});

test("invalid timestamps render no label", () => {
  for (const ms of [NaN, Infinity, -Infinity]) assert.equal(formatMessageTime(ms, now), "");
});
