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

test("createSweeper drops ticks while a pass is in flight and banks no catch-up burst", async () => {
  let started = 0;
  let finished = 0;
  let maxInFlight = 0;
  let release!: () => void;
  const stall = new Promise<void>((r) => {
    release = r;
  });
  const s = createSweeper(async () => {
    started += 1;
    maxInFlight = Math.max(maxInFlight, started - finished);
    if (started === 1) await stall;
    finished += 1;
  }, 10);
  s.start();
  await sleep(60);
  assert.equal(started, 1, "ticks arriving during a slow pass are dropped, not queued");
  assert.equal(maxInFlight, 1);
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(started, 1, "settling the slow pass does not drain a backlog of missed ticks");
  await sleep(35);
  s.stop();
  const after = started;
  assert.ok(after >= 2, `expected ticking to resume after the slow pass settled, got ${after}`);
  assert.equal(finished, after);
  assert.equal(maxInFlight, 1);
  await sleep(30);
  assert.equal(started, after, "no ticks after stop");
});

test("createSweeper keeps blocking overlapping passes across stop and restart", async () => {
  let started = 0;
  let release!: () => void;
  const stall = new Promise<void>((r) => {
    release = r;
  });
  const s = createSweeper(async () => {
    started += 1;
    if (started === 1) await stall;
  }, 10);
  s.start();
  await sleep(25);
  assert.equal(started, 1);
  s.stop();
  s.start();
  await sleep(35);
  assert.equal(started, 1, "restarting begins no second pass while the first is unsettled");
  release();
  await sleep(35);
  s.stop();
  assert.ok(started >= 2, `expected ticking to resume after the held pass settled, got ${started}`);
});

test("createSweeper guards each sweeper separately, so one stalled pass never silences another", async () => {
  let stalledTicks = 0;
  let fastTicks = 0;
  let release!: () => void;
  const stall = new Promise<void>((r) => {
    release = r;
  });
  const stalled = createSweeper(async () => {
    stalledTicks += 1;
    await stall;
  }, 10);
  const fast = createSweeper(() => {
    fastTicks += 1;
  }, 10);
  stalled.start();
  fast.start();
  try {
    await sleep(45);
    assert.equal(stalledTicks, 1, "the stalled sweeper holds its own guard for the whole stall");
    assert.ok(fastTicks >= 2, `expected the other sweeper to keep its rate, got ${fastTicks}`);
  } finally {
    stalled.stop();
    fast.stop();
    release();
  }
});
