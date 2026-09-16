import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatMessageTime } from "../src/message-time.ts";

test("message times include the full date and local time", () => {
  const timestamp = new Date(2026, 8, 13, 9, 40).getTime();
  assert.equal(formatMessageTime(timestamp), "2026-09-13 09:40");
});

test("message times use zero-padded dates and a 24-hour clock", () => {
  assert.equal(formatMessageTime(new Date(2026, 0, 2, 0, 5).getTime()), "2026-01-02 00:05");
  assert.equal(formatMessageTime(new Date(2026, 0, 2, 13, 5).getTime()), "2026-01-02 13:05");
});

test("invalid timestamps do not render invalid dates", () => {
  assert.equal(formatMessageTime(Number.NaN), "");
  assert.equal(formatMessageTime(Number.POSITIVE_INFINITY), "");
});

test("messages at the same time on different dates remain distinguishable", () => {
  const timestamps = [new Date(2025, 8, 13, 9, 40), new Date(2026, 8, 13, 9, 40), new Date(2026, 8, 14, 9, 40)];
  assert.equal(new Set(timestamps.map((date) => formatMessageTime(date.getTime()))).size, timestamps.length);
});

test("message dates follow the local timezone across midnight and at the Unix epoch", () => {
  const moduleUrl = new URL("../src/message-time.ts", import.meta.url).href;
  for (const { timeZone, expected } of [
    { timeZone: "UTC", expected: ["2026-01-01 00:30", "1970-01-01 00:00"] },
    { timeZone: "America/Los_Angeles", expected: ["2025-12-31 16:30", "1969-12-31 16:00"] },
    { timeZone: "Asia/Shanghai", expected: ["2026-01-01 08:30", "1970-01-01 08:00"] },
  ]) {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { formatMessageTime } from ${JSON.stringify(moduleUrl)};
const timestamp = Date.parse("2026-01-01T00:30:00Z");
console.log(JSON.stringify([formatMessageTime(timestamp), formatMessageTime(0)]));`,
      ],
      { encoding: "utf8", env: { ...process.env, TZ: timeZone } },
    );
    assert.deepEqual(JSON.parse(output), expected);
  }
});

test("the shared message footer uses the full timestamp formatter", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.match(chat, /class="message-time">\$\{formatMessageTime\(ts\)\}/);
});
