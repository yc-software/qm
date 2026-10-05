import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { createBackgroundController } from "../src/runs/background-controller.ts";

function setup() {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  const errors: unknown[] = [];
  function replica(deploymentId: string) {
    let starts = 0;
    let stops = 0;
    let failStart = false;
    const drain = Promise.withResolvers<void>();
    const controller = createBackgroundController({
      store,
      deploymentId,
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
  const own = (deploymentId: string | null) => store.set({ ownerDeploymentId: deploymentId, setBy: "test" });
  return { store, replica, errors, own };
}

test("only the owning deployment's replicas run background work and handover is reversible", async () => {
  const { replica, own } = setup();
  const a = replica("a");
  const a2 = replica("a");
  const b = replica("b");
  for (const r of [a, a2, b]) {
    r.controller.start();
    await r.controller.reconcile();
  }
  assert.equal(a.starts(), 0);
  assert.equal(b.starts(), 0);
  assert.equal(a.controller.canClaim(), false);
  await own("a");
  for (const r of [a, a2, b]) await r.controller.reconcile();
  assert.equal(a.starts(), 1);
  assert.equal(a2.starts(), 1);
  assert.equal(b.starts(), 0);
  assert.equal(a.controller.canClaim(), true);
  assert.equal(a.controller.active(), true);
  assert.equal(b.controller.canClaim(), false);
  await own("b");
  for (const r of [a, a2, b]) await r.controller.reconcile();
  assert.equal(a.stops(), 1);
  assert.equal(a2.stops(), 1);
  assert.equal(a.controller.canClaim(), false);
  assert.equal(b.starts(), 1);
  assert.equal(b.controller.canClaim(), true);
  await own("a");
  for (const r of [a, a2, b]) await r.controller.reconcile();
  assert.equal(a.starts(), 2);
  assert.equal(b.stops(), 1);
  assert.equal(b.controller.canClaim(), false);
  await own(null);
  for (const r of [a, a2, b]) await r.controller.reconcile();
  assert.equal(a.stops(), 2);
  assert.equal(a.controller.canClaim(), false);
  a.drain.resolve();
  await a.controller.drained();
  for (const r of [a, a2, b]) {
    r.drain.resolve();
    await r.controller.stop();
  }
});

test("failed activation relinquishes and the next poll retries", async () => {
  const { replica, errors, own } = setup();
  await own("a");
  const a = replica("a");
  a.fail();
  a.controller.start();
  await a.controller.reconcile();
  assert.equal(a.controller.canClaim(), false);
  assert.equal(a.stops(), 1);
  assert.equal(errors.length, 1);
  await a.controller.reconcile();
  assert.equal(a.starts(), 2);
  a.drain.resolve();
  await a.controller.stop();
});

test("database failure fences locally and work resumes once the owner record is readable again", async () => {
  const { store, own } = setup();
  await own("a");
  let disconnected = false;
  let fenced = 0;
  let starts = 0;
  let stops = 0;
  const controller = createBackgroundController({
    store: {
      get: async () => {
        if (disconnected) throw new Error("offline");
        return store.get();
      },
    },
    deploymentId: "a",
    start: async () => {
      starts++;
    },
    fence: () => {
      fenced++;
    },
    relinquish: async () => {
      stops++;
    },
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
  assert.equal(stops, 1);
  disconnected = false;
  await controller.reconcile();
  assert.equal(starts, 2);
  assert.equal(controller.canClaim(), true);
  await controller.stop();
  assert.equal(stops, 2);
  await controller.drained();
});

test("a hanging owner read expires local admission and cannot resurrect it after stop", async () => {
  const { store, own } = setup();
  await own("a");
  const waiting = Promise.withResolvers<void>();
  let hang = false;
  let starts = 0;
  const controller = createBackgroundController({
    store: {
      get: async () => {
        if (hang) await waiting.promise;
        return store.get();
      },
    },
    deploymentId: "a",
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
});

test("a process is active only after startup completes, and expiry during a slow startup aborts it", async () => {
  const { store, own } = setup();
  await own("a");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let stops = 0;
  const controller = createBackgroundController({
    store,
    deploymentId: "a",
    start: async (value) => {
      signal = value;
      started.resolve();
      await finish.promise;
    },
    fence() {},
    relinquish: async () => {
      stops++;
    },
    drained: async () => {},
    onError() {},
    pollMs: 60_000,
    validityMs: 20,
  });
  controller.start();
  await started.promise;
  assert.equal(controller.canClaim(), true);
  assert.equal(controller.active(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(signal?.aborted, true);
  finish.resolve();
  await controller.reconcile();
  assert.equal(stops, 1);
  assert.equal(controller.active(), false);
  await controller.stop();
});

for (const outcome of ["complete", "handover", "read-failure", "read-stall", "stop", "startup-timeout"] as const) {
  test(`pending startup renews verified ownership and fences on ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
    const { store, own } = setup();
    await own("a");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    let readMode = "normal";
    let signal: AbortSignal | undefined;
    let starts = 0;
    let starting = false;
    let stops = 0;
    let reads = 0;
    let maxReads = 0;
    const errors: unknown[] = [];
    const controller = createBackgroundController({
      store: {
        get: async () => {
          reads++;
          maxReads = Math.max(maxReads, reads);
          try {
            if (readMode === "fail") throw new Error("offline");
            if (readMode === "stall") await read.promise;
            return await store.get();
          } finally {
            reads--;
          }
        },
      },
      deploymentId: "a",
      start: async (value) => {
        starts++;
        starting = true;
        signal = value;
        started.resolve();
        await finish.promise;
        starting = false;
      },
      fence() {},
      relinquish: async () => {
        assert.equal(starting, false);
        stops++;
      },
      drained: async () => {},
      onError: (error) => errors.push(error),
      pollMs: 10,
      validityMs: 100,
      startupTimeoutMs: 500,
    });
    controller.start();
    await started.promise;
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    for (let tick = 0; tick < 30; tick++) {
      t.mock.timers.tick(10);
      await flush();
      assert.equal(controller.canClaim(), true);
      assert.equal(signal?.aborted, false);
    }
    assert.equal(starts, 1);
    assert.equal(stops, 0);
    if (outcome === "handover") await own("b");
    if (outcome === "read-failure") readMode = "fail";
    if (outcome === "read-stall" || outcome === "stop") readMode = "stall";
    t.mock.timers.tick(10);
    await flush();
    const stopping = outcome === "stop" ? controller.stop() : undefined;
    if (outcome === "startup-timeout") {
      for (let tick = 0; tick < 30; tick++) {
        t.mock.timers.tick(10);
        await flush();
      }
      assert.equal(starts, 1);
      assert.equal(stops, 0);
    }
    if (outcome === "read-stall" || outcome === "stop") {
      t.mock.timers.tick(110);
      await flush();
      assert.equal(signal?.aborted, true);
      readMode = "normal";
      read.resolve();
      await flush();
    }
    assert.equal(controller.canClaim(), outcome === "complete");
    assert.equal(signal?.aborted, outcome !== "complete");
    const reconciled = controller.reconcile();
    finish.resolve();
    await reconciled;
    await stopping;
    assert.equal(starts, 1);
    assert.equal(maxReads, 1);
    assert.equal(errors.length, outcome === "read-failure" || outcome === "startup-timeout" ? 1 : 0);
    await controller.stop();
    await controller.drained();
    assert.equal(stops, 1);
  });
}
