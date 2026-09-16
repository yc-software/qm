import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { createBackgroundController } from "../src/runs/background-controller.ts";

async function setup() {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  const errors: unknown[] = [];
  function replica(instanceId: string, deploymentId: string, legacyEnabled = false) {
    let starts = 0;
    let stops = 0;
    let failStart = false;
    const drain = Promise.withResolvers<void>();
    const controller = createBackgroundController({
      store,
      identity: { instanceId, deploymentId, taskArn: `task:${instanceId}` },
      legacyEnabled,
      start: async () => {
        starts++;
        if (failStart) throw new Error("activation failed");
      },
      fence() {},
      relinquish: async () => {
        stops++;
      },
      drained: () => drain.promise,
      onError: (error) => errors.push(error),
      pollMs: 60_000,
      validityMs: 60_000,
    });
    return {
      controller,
      drain,
      starts: () => starts,
      stops: () => stops,
      fail: () => {
        failStart = true;
      },
    };
  }
  return { store, replica, errors };
}

test("two deployments hand over all replicas while previous work remains draining", async () => {
  const { store, replica } = await setup();
  const a = replica("a1", "a", true);
  const a2 = replica("a2", "a", true);
  const b = replica("b1", "b");
  for (const r of [a, a2, b]) {
    r.controller.start();
    await r.controller.reconcile();
  }
  assert.equal(a.starts(), 1);
  assert.equal(b.starts(), 0);
  await store.transition({
    expectedGeneration: 0,
    requestId: "bootstrap",
    desiredDeploymentId: "b",
    bootstrapTaskArns: ["task:a1", "task:a2", "task:b1"],
  });
  await b.controller.reconcile();
  assert.equal(b.starts(), 0);
  await a.controller.reconcile();
  await b.controller.reconcile();
  assert.equal(b.starts(), 0);
  await a2.controller.reconcile();
  await b.controller.reconcile();
  assert.equal(b.starts(), 1);
  assert.equal(a.controller.canClaim(), false);
  assert.equal((await store.get()).members.find((m) => m.instanceId === "a1")?.state, "relinquished");
  await store.transition({ expectedGeneration: 1, requestId: "rollback", desiredDeploymentId: "a" });
  await b.controller.reconcile();
  await a.controller.reconcile();
  assert.equal(a.starts(), 2);
  a.drain.resolve();
  await a.controller.drained();
  assert.equal((await store.get()).members.find((m) => m.instanceId === "a1")?.state, "admitted");
  for (const r of [a, a2, b]) {
    r.drain.resolve();
    await r.controller.stop();
  }
});

test("failed activation relinquishes membership and allows a reversible successor", async () => {
  const { store, replica, errors } = await setup();
  const a = replica("a", "a", true);
  a.fail();
  a.controller.start();
  await a.controller.reconcile();
  assert.equal(a.controller.canClaim(), false);
  assert.equal((await store.get()).members[0]?.state, "relinquished");
  assert.equal(errors.length, 1);
  a.drain.resolve();
  await a.controller.stop();
});

test("database failure fences locally without inventing a durable relinquishment", async () => {
  const { store } = await setup();
  let disconnected = false;
  let fenced = 0;
  const controller = createBackgroundController({
    store: {
      ...store,
      get: async () => {
        if (disconnected) throw new Error("offline");
        return store.get();
      },
      acknowledge: async (...args) => {
        if (disconnected) throw new Error("offline");
        return store.acknowledge(...args);
      },
    },
    identity: { instanceId: "a", deploymentId: "a", taskArn: "task:a" },
    legacyEnabled: true,
    start: async () => {},
    fence: () => {
      fenced++;
    },
    relinquish: async () => {},
    drained: async () => {},
    onError() {},
    pollMs: 60_000,
  });
  controller.start();
  await controller.reconcile();
  assert.equal(controller.canClaim(), true);
  disconnected = true;
  await controller.reconcile();
  assert.equal(controller.canClaim(), false);
  assert.ok(fenced > 0);
  assert.equal((await store.get()).members[0]?.state, "admitted");
  disconnected = false;
  await controller.stop();
  await controller.drained();
  assert.equal((await store.get()).members[0]?.state, "drained");
});

test("a hanging database read expires local admission and cannot resurrect it after stop", async () => {
  const { store } = await setup();
  const waiting = Promise.withResolvers<void>();
  let hang = false;
  let starts = 0;
  const controller = createBackgroundController({
    store: {
      ...store,
      get: async () => {
        if (hang) await waiting.promise;
        return store.get();
      },
    },
    identity: { instanceId: "a", deploymentId: "a", taskArn: "task:a" },
    legacyEnabled: true,
    start: async () => {
      starts++;
    },
    fence() {},
    relinquish: async () => {},
    drained: async () => {},
    onError() {},
    pollMs: 60_000,
    validityMs: 20,
  });
  controller.start();
  await controller.reconcile();
  hang = true;
  const reconcile = controller.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(controller.canClaim(), false);
  const stop = controller.stop();
  waiting.resolve();
  await Promise.all([reconcile, stop]);
  assert.equal(starts, 1);
  assert.equal(controller.canClaim(), false);
  await controller.drained();
  assert.equal((await store.get()).members[0]?.state, "drained");
});

test("activation is not ready until startup completes and expiry fences a late startup", async () => {
  const { store } = await setup();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const controller = createBackgroundController({
    store,
    identity: { instanceId: "a", deploymentId: "a", taskArn: "task:a" },
    legacyEnabled: true,
    start: async (value) => {
      signal = value;
      started.resolve();
      await finish.promise;
    },
    fence() {},
    relinquish: async () => {},
    drained: async () => {},
    onError() {},
    pollMs: 60_000,
    validityMs: 20,
  });
  controller.start();
  await started.promise;
  assert.equal((await store.get()).members[0]?.ready, false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(signal?.aborted, true);
  finish.resolve();
  await controller.reconcile();
  assert.equal((await store.get()).members[0]?.ready, false);
  await controller.stop();
});
