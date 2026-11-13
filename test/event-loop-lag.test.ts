import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { logEventLoopLag } from "../src/util/event-loop-lag.ts";
import { settle } from "./support/settle.ts";

test("a blocked event loop shows up in the next lag line", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const sweeper = logEventLoopLag(500);
  await sleep(50);
  const blockedUntil = Date.now() + 300;
  while (Date.now() < blockedUntil);
  await settle(async () => lines.length > 0);
  await sweeper.stop();
  const [tag, , , p50, , , , max, unit] = lines[0]!.split(" ");
  assert.deepEqual([tag, unit, Number(p50) < 50, Number(max) >= 200], ["[event-loop]", "ms", true, true]);
});
