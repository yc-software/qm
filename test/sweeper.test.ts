import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSweeper } from "../src/util/sweeper.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("createSweeper ticks fn on the interval until stopped", async () => {
  let ticks = 0;
  const s = createSweeper(() => {
    ticks += 1;
  }, 10);
  s.start();
  await sleep(35);
  s.stop();
  const after = ticks;
  assert.ok(after >= 2, `expected multiple ticks, got ${after}`);
  await sleep(30);
  assert.equal(ticks, after, "no ticks after stop");
});

test("createSweeper start is idempotent (no double interval)", async () => {
  let ticks = 0;
  const s = createSweeper(() => {
    ticks += 1;
  }, 10);
  s.start();
  s.start();
  await sleep(35);
  s.stop();
  assert.ok(ticks <= 4, `expected a single interval's tick rate, got ${ticks}`);
});

test("createSweeper survives a throwing or rejecting fn", async () => {
  let ticks = 0;
  const s = createSweeper(() => {
    ticks += 1;
    if (ticks === 1) throw new Error("sync boom");
    if (ticks === 2) return Promise.reject(new Error("async boom"));
    return undefined;
  }, 10);
  s.start();
  await sleep(45);
  s.stop();
  assert.ok(ticks >= 3, `interval kept ticking past failures, got ${ticks}`);
});

test("createSweeper with immediate sweeps once on start, before the first interval", async () => {
  let ticks = 0;
  const s = createSweeper(
    () => {
      ticks += 1;
    },
    60_000,
    { immediate: true },
  );
  s.start();
  assert.equal(ticks, 1, "swept synchronously on start");
  s.stop();
  await sleep(15);
  assert.equal(ticks, 1, "no further ticks after stop");
});

test("createSweeper without immediate does not sweep on start", () => {
  let ticks = 0;
  const s = createSweeper(() => {
    ticks += 1;
  }, 60_000);
  s.start();
  assert.equal(ticks, 0);
  s.stop();
});

test("createSweeper start(intervalMs) overrides the construction-time interval", async () => {
  let ticks = 0;
  const s = createSweeper(() => {
    ticks += 1;
  }, 60_000);
  s.start(10);
  await sleep(35);
  s.stop();
  assert.ok(ticks >= 2, `expected ticks at the start-time interval, got ${ticks}`);
});

test("createSweeper tags swallowed failures with its label", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const s = createSweeper(
    () => {
      throw new Error("boom");
    },
    5,
    { label: "test-loop" },
  );
  s.start();
  await sleep(25);
  s.stop();
  assert.ok(
    logged.some((l) => l.includes("test-loop: sweep failed") && l.includes("boom")),
    `expected a labelled swallow line, got: ${logged.join(" | ")}`,
  );
});

test("createSweeper unrefs its timer so it never keeps the process alive", () => {
  const calls: unknown[] = [];
  const fakeTimer = { unref: () => calls.push("unref") } as unknown as ReturnType<typeof setInterval>;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => fakeTimer) as unknown as typeof setInterval;
  try {
    const s = createSweeper(() => {}, 10);
    s.start();
    s.stop();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.deepEqual(calls, ["unref"], "the interval was unref()'d on start");
});
