import assert from "node:assert/strict";
import test from "node:test";
import { createSlackRuntimeReconciler } from "../src/surfaces/slack-runtime.ts";
import { createMemoryEventBus, type LocalEventBus } from "../src/util/event-bus.ts";

type Change = { version: string };

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

function harness(load: () => Promise<{ version: string; config: string } | null>, changes?: LocalEventBus<Change>) {
  const events: string[] = [];
  const errors: unknown[] = [];
  const runtime = createSlackRuntimeReconciler<string>({
    load,
    startPlugin: async (config) => {
      if (config === "broken") throw new Error("start failed");
      events.push(`start:${config}`);
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
    changes,
    onError: (error) => errors.push(error),
  });
  return { runtime, events, errors };
}

test("catches a failed read waiting out the repair delay, or a healthy instance polling on the retry delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failing = true;
  let loads = 0;
  const { runtime, errors } = harness(async () => {
    loads += 1;
    if (failing) throw new Error("installation read failed");
    return null;
  });
  runtime.start();
  await settle();
  assert.deepEqual([loads, errors.length], [1, 1]);

  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual([loads, errors.length], [2, 2], "a failed read retries fast and reports every attempt");

  failing = false;
  t.mock.timers.tick(5_000);
  await settle();
  t.mock.timers.tick(299_999);
  await settle();
  assert.deepEqual([loads, errors.length], [3, 2], "a healthy instance stops re-reading every few seconds");

  t.mock.timers.tick(1);
  await settle();
  assert.equal(loads, 4, "the repair tick still re-reads");
  await runtime.stop();
});

test("catches a reconciler that ignores installation events or restarts an unchanged plugin on resync", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = createMemoryEventBus<Change>("test-installation");
  let desired = { version: "1", config: "first" };
  let loads = 0;
  const { runtime, events } = harness(async () => {
    loads += 1;
    return desired;
  }, changes);
  runtime.start();
  await settle();
  assert.deepEqual(events, ["start:first"]);

  desired = { version: "2", config: "second" };
  changes.emit({ version: "2" });
  await settle();
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"], "a rotated version reloads without a tick");

  changes.resync();
  await settle();
  assert.equal(loads, 3, "a reconnect re-reads the durable record");
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"], "an unchanged version keeps the plugin up");
  await runtime.stop();
});

test("catches events that arrive during a reconcile overlapping it or being dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = createMemoryEventBus<Change>("test-installation");
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let loads = 0;
  const { runtime } = harness(async () => {
    loads += 1;
    if (loads === 1) await gate;
    return null;
  }, changes);
  runtime.start();
  await settle();
  changes.emit({ version: "a" });
  changes.emit({ version: "b" });
  changes.emit({ version: "c" });
  await settle();
  assert.equal(loads, 1, "no reconcile overlaps the one in flight");

  release();
  await settle();
  assert.equal(loads, 2, "three events during one reconcile coalesce into a single follow-up");
  await runtime.stop();
});

test("catches stop() abandoning the plugin a rejecting reconcile left running, or staying subscribed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = createMemoryEventBus<Change>("test-installation");
  let desired = { version: "1", config: "first" };
  let loads = 0;
  const { runtime, events } = harness(async () => {
    loads += 1;
    return desired;
  }, changes);
  runtime.start();
  await settle();
  desired = { version: "2", config: "broken" };
  const inFlight = runtime.reconcile();
  const stopping = runtime.stop();
  await assert.rejects(Promise.all([inFlight, stopping]), /start failed/);
  assert.deepEqual(events, ["start:first", "stop:first", "start:first", "stop:first"]);

  changes.emit({ version: "3" });
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(loads, 2, "a stopped reconciler ignores later events and rearms no timer");
});
