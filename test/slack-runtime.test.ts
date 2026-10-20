import assert from "node:assert/strict";
import test from "node:test";
import { createSlackRuntimeReconciler, SlackPluginStartCleanupError } from "../src/surfaces/slack-runtime.ts";

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
    intervalMs: 60_000,
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

test("Slack stop finishes cleanup even when the pending configuration load fails", async () => {
  const loading = Promise.withResolvers<void>();
  let loads = 0;
  let stops = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      if (++loads > 1) {
        await loading.promise;
        throw new Error("database disconnected");
      }
      return { version: "1", config: "first" };
    },
    startPlugin: async () => ({
      stop: async () => {
        stops++;
      },
    }),
  });
  await runtime.reconcile();
  const pending = assert.rejects(runtime.reconcile(), /database disconnected/);
  const stopping = runtime.stop();
  loading.resolve();
  await Promise.all([pending, stopping]);
  assert.equal(stops, 1);
  await runtime.reconcile();
  assert.equal(loads, 2);
});

test("Slack stop fences a pending load and repeated starts leave no polling timer behind", async () => {
  const loading = Promise.withResolvers<void>();
  let loads = 0;
  let starts = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => {
      loads++;
      await loading.promise;
      return { version: "1", config: "first" };
    },
    startPlugin: async () => {
      starts++;
      return { stop: async () => {} };
    },
    intervalMs: 5,
  });
  runtime.start();
  runtime.start();
  const stopping = runtime.stop();
  loading.resolve();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loads, 1);
  assert.equal(starts, 0);
  runtime.start();
  await runtime.reconcile();
  await runtime.stop();
  assert.equal(starts, 1);
});

test("Slack stop waits for an opening socket, collapses repeated stops, and permits a clean resume", async () => {
  const opening = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  let starts = 0;
  let stops = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => ({ version: "1", config: "first" }),
    startPlugin: async () => {
      starts++;
      opened.resolve();
      await opening.promise;
      return {
        stop: async () => {
          stops++;
        },
      };
    },
  });
  runtime.start();
  await opened.promise;
  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping);
  runtime.start();
  opening.resolve();
  await stopping;
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  runtime.start();
  await runtime.reconcile();
  await runtime.stop();
  assert.equal(starts, 2);
  assert.equal(stops, 2);
});

test("Slack stop during a failed replacement does not resurrect rollback credentials", async () => {
  const failing = Promise.withResolvers<void>();
  const opening = Promise.withResolvers<void>();
  let desired = { version: "1", config: "first" };
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => desired,
    startPlugin: async (config) => {
      events.push(`start:${config}`);
      if (config === "second") {
        opening.resolve();
        await failing.promise;
        throw new Error("failed activation");
      }
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
  });
  await runtime.reconcile();
  desired = { version: "2", config: "second" };
  const pending = assert.rejects(runtime.reconcile(), /failed activation/);
  await opening.promise;
  const stopping = runtime.stop();
  failing.resolve();
  await Promise.all([pending, stopping]);
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"]);
});

test("Slack cannot resume after failed socket closure until stop succeeds", async () => {
  let starts = 0;
  let stops = 0;
  const runtime = createSlackRuntimeReconciler({
    load: async () => ({ version: "1", config: "first" }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          if (++stops === 1) throw new Error("socket close failed");
        },
      };
    },
  });
  await runtime.reconcile();
  await assert.rejects(runtime.stop(), /socket close failed/);
  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);
  await runtime.stop();
  runtime.start();
  await runtime.reconcile();
  await runtime.stop();
  assert.equal(starts, 2);
  assert.equal(stops, 3);
});

test("uncertain failed startup cleanup blocks repeated stop acknowledgments and rollback until it closes", async () => {
  let desired = { version: "1", config: "first" };
  let cleanupAllowed = false;
  const events: string[] = [];
  const runtime = createSlackRuntimeReconciler({
    load: async () => desired,
    startPlugin: async (config) => {
      events.push(`start:${config}`);
      if (config === "second")
        throw new SlackPluginStartCleanupError(new Error("start failed"), new Error("close failed"), async () => {
          events.push("cleanup:second");
          if (!cleanupAllowed) throw new Error("still open");
        });
      return {
        stop: async () => {
          events.push(`stop:${config}`);
        },
      };
    },
  });
  await runtime.reconcile();
  desired = { version: "2", config: "second" };
  await assert.rejects(runtime.reconcile(), SlackPluginStartCleanupError);
  assert.deepEqual(events, ["start:first", "stop:first", "start:second"]);
  await assert.rejects(runtime.stop(), /still open/);
  await assert.rejects(runtime.stop(), /still open/);
  runtime.start();
  await runtime.reconcile();
  assert.equal(events.filter((event) => event.startsWith("start:")).length, 2);
  cleanupAllowed = true;
  await runtime.stop();
  desired = { version: "3", config: "third" };
  runtime.start();
  await runtime.reconcile();
  await runtime.stop();
  assert.equal(events.at(-2), "start:third");
  assert.equal(events.at(-1), "stop:third");
});

test("a rollback startup with incomplete cleanup also blocks relinquishment", async () => {
  let desired = { version: "1", config: "first" };
  let firstStarts = 0;
  let cleanupAllowed = false;
  const runtime = createSlackRuntimeReconciler({
    load: async () => desired,
    startPlugin: async (config) => {
      if (config === "second") throw new Error("replacement failed");
      if (++firstStarts > 1)
        throw new SlackPluginStartCleanupError(new Error("rollback failed"), new Error("close failed"), async () => {
          if (!cleanupAllowed) throw new Error("rollback still open");
        });
      return { stop: async () => {} };
    },
  });
  await runtime.reconcile();
  desired = { version: "2", config: "second" };
  await assert.rejects(runtime.reconcile(), /reload and rollback both failed/);
  await assert.rejects(runtime.stop(), /rollback still open/);
  cleanupAllowed = true;
  await runtime.stop();
});

test("a controlled inactive Slack runtime cannot open a socket through configuration reconciliation", async () => {
  let starts = 0;
  const runtime = createSlackRuntimeReconciler({
    startPaused: true,
    load: async () => ({ version: "installed", config: {} }),
    startPlugin: async () => {
      starts++;
      return { stop: async () => {} };
    },
  });
  await runtime.reconcile();
  await runtime.reconcile();
  assert.equal(starts, 0);
  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);
  await runtime.stop();
  await runtime.reconcile();
  assert.equal(starts, 1);
});

test("failed Slack account retries independently while background ownership and another account stay active", async () => {
  const { createMemoryMap } = await import("../src/persistence/durable-map.ts");
  const { createBackgroundOwnershipStore } = await import("../src/runs/background-ownership.ts");
  const { createBackgroundController } = await import("../src/runs/background-controller.ts");
  const store = createBackgroundOwnershipStore(createMemoryMap());
  const errors: unknown[] = [];
  let inactive = true;
  let attempts = 0;
  let healthyStarts = 0;
  let stops = 0;
  const failed = createSlackRuntimeReconciler({
    startPaused: true,
    intervalMs: 5,
    load: async () => ({ version: "first", config: "inactive" }),
    startPlugin: async () => {
      attempts++;
      if (inactive) throw new Error("account_inactive");
      return {
        stop: async () => {
          stops++;
        },
      };
    },
    onError: (error) => errors.push(error),
  });
  const healthy = createSlackRuntimeReconciler({
    startPaused: true,
    intervalMs: 5,
    load: async () => ({ version: "first", config: "healthy" }),
    startPlugin: async () => {
      healthyStarts++;
      return {
        stop: async () => {
          stops++;
        },
      };
    },
  });
  const controller = createBackgroundController({
    store,
    deploymentId: "deployment",
    start: async () => {
      failed.start();
      healthy.start();
    },
    fence() {},
    relinquish: async () => {
      await failed.stop();
      await healthy.stop();
    },
    drained: async () => {},
    onError: (error) => {
      throw error;
    },
    pollMs: 60_000,
  });
  await store.set({ ownerDeploymentId: "deployment", setBy: "test" });
  try {
    controller.start();
    await controller.reconcile();
    await healthy.reconcile();
    assert.equal(controller.canClaim(), true);
    assert.equal(healthyStarts, 1);
    const deadline = Date.now() + 2000;
    while (attempts < 2) {
      assert.ok(Date.now() < deadline, "failed account should retry");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(errors.length >= 1);
    assert.equal(controller.canClaim(), true);
    inactive = false;
    await failed.reconcile();
    assert.equal(healthyStarts, 1);
  } finally {
    await controller.stop();
    await failed.stop();
    await healthy.stop();
  }
  assert.equal(stops, 2);
  const stoppedAttempts = attempts;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, stoppedAttempts);
});
