import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
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

test("createSweeper tags reported failures with its label", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
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
    `expected a labelled failure line, got: ${logged.join(" | ")}`,
  );
});

test("createSweeper unrefs its timer so it never keeps the process alive", () => {
  const calls: unknown[] = [];
  const fakeTimer = { unref: () => calls.push("unref") } as unknown as ReturnType<typeof setTimeout>;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (() => fakeTimer) as unknown as typeof setTimeout;
  try {
    const s = createSweeper(() => {}, 10);
    s.start();
    s.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(calls, ["unref"], "the timer was unref()'d on start");
});

test("tenant sweepers share one timer and retain their creation context", async (t) => {
  const context = new AsyncLocalStorage<string>();
  const observed = new Map<string, string | undefined>();
  const fired = new Set<string>();
  const finished = Promise.withResolvers<void>();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof setTimeout>>();
  let mostActive = 0;
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
    const handle = originalSetTimeout(() => {
      active.delete(handle);
      fn();
    }, ms);
    active.add(handle);
    mostActive = Math.max(mostActive, active.size);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout>) => {
    active.delete(handle);
    originalClearTimeout(handle);
  });
  const sweepers = Array.from({ length: 50 }, (_, index) => {
    const tenant = `tenant-${index}`;
    return context.run(tenant, () =>
      createSweeper(() => {
        observed.set(tenant, context.getStore());
        fired.add(tenant);
        if (fired.size === 50) finished.resolve();
      }, 5 + index),
    );
  });
  const keepAlive = originalSetTimeout(() => finished.reject(new Error("sweepers did not run")), 1_000);
  try {
    for (const sweeper of sweepers) sweeper.start();
    await finished.promise;
    assert.equal(mostActive, 1);
    assert.equal(observed.size, 50);
    for (const [tenant, actual] of observed) assert.equal(actual, tenant);
  } finally {
    await Promise.all(sweepers.map((sweeper) => sweeper.stop()));
    originalClearTimeout(keepAlive);
  }
  assert.equal(active.size, 0);
});

test("stopping one tenant drains its work while other tenant sweepers continue", async () => {
  const gate = Promise.withResolvers<void>();
  let otherTicks = 0;
  const stopping = createSweeper(() => gate.promise, 60_000, { immediate: true });
  const other = createSweeper(() => otherTicks++, 5);
  stopping.start();
  other.start();
  const drained = stopping.stop();
  try {
    await sleep(25);
    assert.ok(otherTicks >= 2);
  } finally {
    gate.resolve();
    await drained;
    await other.stop();
  }
});

test("stop waits for all admitted sweeps and fences a restart until they settle", async () => {
  const first = Promise.withResolvers<void>();
  let ticks = 0;
  const s = createSweeper(
    async () => {
      ticks++;
      await first.promise;
    },
    60_000,
    { immediate: true },
  );
  s.start();
  assert.equal(ticks, 1);
  let settled = false;
  const stopping = s.stop();
  assert.equal(s.stop(), stopping);
  void stopping.then(() => {
    settled = true;
  });
  s.start();
  await sleep(10);
  assert.equal(ticks, 1);
  assert.equal(settled, false);
  first.resolve();
  await stopping;
  s.start();
  assert.equal(ticks, 2);
  await s.stop();
});

test("stop drains overlapping callbacks including failed work before acknowledging", async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0;
  const s = createSweeper(async () => {
    active++;
    await gate.promise;
    active--;
    throw new Error("expected sweep failure");
  }, 5);
  s.start();
  await sleep(20);
  assert.ok(active > 1);
  const stopping = s.stop();
  gate.resolve();
  await stopping;
  assert.equal(active, 0);
});
