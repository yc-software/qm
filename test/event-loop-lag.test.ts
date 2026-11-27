import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { logEventLoopLag } from "../src/util/event-loop-lag.ts";
import { settle } from "./support/settle.ts";

test("a blocked event loop shows up in the next lag line alongside memory stats", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const sweeper = logEventLoopLag(500);
  await sleep(50);
  const blockedUntil = Date.now() + 300;
  while (Date.now() < blockedUntil);
  await settle(async () => lines.length >= 2);
  await sweeper.stop();
  const [tag, , , p50, , , , max, unit] = lines[0]!.split(" ");
  assert.deepEqual([tag, unit, Number(p50) < 50, Number(max) >= 200], ["[event-loop]", "ms", true, true]);
  assert.match(
    lines[1]!,
    /^\[memory\] rss=\d+ heapUsed=\d+ heapTotal=\d+ heapLimit=\d+ external=\d+ arrayBuffers=\d+ MB$/,
  );
});

test("slow GC pauses are logged and observer disconnects on stop", async (t) => {
  const warns: string[] = [];
  t.mock.method(console, "warn", (line: string) => warns.push(line));
  const sweeper = logEventLoopLag(60_000, 0);
  for (let i = 0; i < 64; i++) Array.from({ length: 100_000 }, () => i);
  await settle(async () => warns.length > 0);
  assert.match(warns[0]!, /^\[gc\] kind=(scavenge|mark-sweep-compact|incremental-marking|weakcb) duration=\d+ ms$/);
  await sweeper.stop();
  const afterStop = warns.length;
  for (let i = 0; i < 64; i++) Array.from({ length: 100_000 }, () => i);
  await sleep(50);
  assert.equal(warns.length, afterStop);
});
