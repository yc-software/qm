import assert from "node:assert/strict";
import test from "node:test";
import { createSlackRuntimeReconciler } from "../src/surfaces/slack-runtime.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("Slack runtime activates, reloads, and removes durable admin configuration", async () => {
  let desired: { version: string; config: { botToken: string } } | null = null;
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => desired,
    startPlugin: async (config) => {
      events.push(`start:${config.botToken}`);
      return {
        stop: async () => {
          events.push(`stop:${config.botToken}`);
        },
      };
    },
  });
  runtime.start();
  await runtime.reconcile();
  assert.deepEqual(events, []);

  desired = { version: "1", config: { botToken: "first" } };
  await runtime.reconcile();
  assert.deepEqual(events, ["start:first"]);

  desired = { version: "2", config: { botToken: "second" } };
  await runtime.reconcile();
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"]);

  desired = null;
  await runtime.reconcile();
  assert.deepEqual(events, ["start:first", "stop:first", "start:second", "stop:second"]);
  await runtime.stop();
});

test("Slack runtime restores the previous configuration when a reload cannot start", async () => {
  let desired = { version: "1", config: "first" };
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => desired,
    startPlugin: async (config) => {
      events.push(`start:${config}`);
      if (config === "broken") throw new Error("broken");
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
  });
  await runtime.reconcile();
  desired = { version: "2", config: "broken" };
  await assert.rejects(runtime.reconcile(), /broken/);
  assert.deepEqual(events, ["start:first", "stop:first", "start:broken", "start:first"]);
  await runtime.stop();
});

test("Slack runtime keeps retrying a failed stop before starting replacement credentials", async () => {
  let desired = { version: "1", config: "first" };
  let stopAttempts = 0;
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => desired,
    startPlugin: async (config) => {
      events.push(`start:${config}`);
      return {
        stop: async () => {
          events.push(`stop:${config}`);
          if (config === "first" && ++stopAttempts === 1) throw new Error("stop failed");
        },
      };
    },
  });
  await runtime.reconcile();
  desired = { version: "2", config: "second" };
  await assert.rejects(runtime.reconcile(), /stop failed/);
  await runtime.reconcile();
  assert.deepEqual(events, ["start:first", "stop:first", "stop:first", "start:second"]);
  await runtime.stop();
});

test("the reconciler reads once at startup and again only on the slow repair tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      loads += 1;
      return null;
    },
    startPlugin: async () => ({ stop: async () => {} }),
  });
  runtime.start();
  await settle();
  assert.equal(loads, 1);

  t.mock.timers.tick(299_999);
  await settle();
  assert.equal(loads, 1, "an idle instance no longer re-reads the installation every few seconds");

  t.mock.timers.tick(1);
  await settle();
  assert.equal(loads, 2);
  await runtime.stop();
});

test("an installation event reloads immediately and a reconnect resync does not restart an unchanged plugin", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = createMemoryEventBus<{ version: string }>("test-installation");
  let desired = { version: "1", config: "first" };
  let loads = 0;
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      loads += 1;
      return desired;
    },
    startPlugin: async (config) => {
      events.push(`start:${config}`);
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
    changes,
  });
  runtime.start();
  await settle();
  assert.deepEqual(events, ["start:first"]);

  desired = { version: "2", config: "second" };
  changes.emit({ version: "2" });
  await settle();
  assert.equal(loads, 2);
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"]);

  changes.resync();
  await settle();
  assert.equal(loads, 3, "a reconnect re-reads the durable record");
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"]);
  await runtime.stop();
});

test("events arriving during a reconcile collapse into exactly one trailing run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = createMemoryEventBus<{ version: string }>("test-installation");
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let loads = 0;
  let concurrent = 0;
  let peak = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      loads += 1;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      if (loads === 1) await gate;
      concurrent -= 1;
      return null;
    },
    startPlugin: async () => ({ stop: async () => {} }),
    changes,
  });
  runtime.start();
  await settle();
  assert.equal(loads, 1);

  changes.emit({ version: "a" });
  changes.emit({ version: "b" });
  changes.emit({ version: "c" });
  await settle();
  assert.equal(loads, 1, "no reconcile overlaps the one in flight");

  release();
  await settle();
  assert.equal(loads, 2, "three events during one reconcile coalesce into a single follow-up");
  assert.equal(peak, 1);
  await runtime.stop();
});

test("a failed reconcile retries on the fast cadence and returns to repair once it succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failing = true;
  let loads = 0;
  const errors: unknown[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      loads += 1;
      if (failing) throw new Error("installation read failed");
      return null;
    },
    startPlugin: async () => ({ stop: async () => {} }),
    onError: (error) => errors.push(error),
  });
  runtime.start();
  await settle();
  assert.deepEqual([loads, errors.length], [1, 1]);

  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual([loads, errors.length], [2, 2], "each failed attempt is reported");

  failing = false;
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual([loads, errors.length], [3, 2]);

  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(loads, 3, "a healthy reconcile drops back to the slow repair cadence");
  await runtime.stop();
});

test("stop() unsubscribes, so a later installation event neither reloads nor rearms a timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = createMemoryEventBus<{ version: string }>("test-installation");
  let loads = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      loads += 1;
      return null;
    },
    startPlugin: async () => ({ stop: async () => {} }),
    changes,
  });
  runtime.start();
  await settle();
  assert.equal(loads, 1);
  await runtime.stop();

  changes.emit({ version: "2" });
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(loads, 1);
});

test("stop() shuts the active plugin down even when the reconcile in flight fails", async () => {
  let failing = false;
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      if (failing) throw new Error("installation read failed");
      return { version: "1", config: "first" };
    },
    startPlugin: async (config) => {
      events.push(`start:${config}`);
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
  });
  await runtime.reconcile();
  failing = true;
  const inFlight = runtime.reconcile();
  await assert.rejects(Promise.all([inFlight, runtime.stop()]), /installation read failed/);
  assert.deepEqual(events, ["start:first", "stop:first"]);
});

test("stop() waits for a reconcile already in flight and shuts down the plugin it started", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => ({ version: "1", config: "first" }),
    startPlugin: async (config) => {
      await gate;
      events.push(`start:${config}`);
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
  });
  const inFlight = runtime.reconcile();
  const stopping = runtime.stop();
  release();
  await Promise.all([inFlight, stopping]);
  assert.deepEqual(events, ["start:first", "stop:first"], "a plugin started mid-shutdown does not outlive stop()");
});
