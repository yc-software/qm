import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { beforeEach, mock, test, type TestContext } from "node:test";
import { createTenantContext } from "../src/tenancy/context.ts";

type DrainRuntime = { stop(): Promise<void>; releaseInFlightRuns(): Promise<void> };

let stoppers: Map<string, () => Promise<void>>;
let releasers: Map<string, () => Promise<void>>;
let backstopRuntime: DrainRuntime | undefined;
let events: string[];
let preparationGates: Map<string, Promise<void>>;
let listenerGate: Promise<void> | undefined;
let failedActivation: string | undefined;

class HostServer extends EventEmitter {
  listen(_port: number, callback: () => void): this {
    events.push("listener:bind");
    void Promise.resolve(listenerGate).then(() => {
      events.push("listener:ready");
      callback();
    });
    return this;
  }
  close(callback?: (error?: Error) => void): this {
    events.push("listener:close");
    callback?.();
    return this;
  }
  closeIdleConnections(): void {}
  closeAllConnections(): void {}
}

mock.module("../src/tenancy/manifest.ts", {
  namedExports: {
    loadHostConfig: () => ({
      concurrency: 1,
      port: 8080,
      pooled: true,
      tenants: ["broken", "healthy"].map((id) => ({
        context: createTenantContext({ id, env: {} }),
        config: { shutdownDrainMs: 60_000 },
        hosts: [],
      })),
    }),
  },
});
mock.module("../src/tenancy/runtime.ts", {
  namedExports: {
    prepareTenant: async (context: { id: string }) => {
      events.push(`prepare:${context.id}`);
      await preparationGates.get(context.id);
      events.push(`prepared:${context.id}`);
      return {
        start: async () => {
          events.push(`start:${context.id}`);
          if (failedActivation === context.id) throw new Error("activation failed");
        },
        listener() {},
        stop: async () => {
          events.push(`stop:${context.id}`);
          await stoppers.get(context.id)?.();
        },
        releaseInFlightRuns: async () => {
          await releasers.get(context.id)?.();
        },
      };
    },
  },
});
mock.module("../src/tenancy/router.ts", {
  namedExports: { createTenantRouter() {}, createHostServer: () => new HostServer() },
});
mock.module("../src/util/process-guard.ts", {
  namedExports: { shutdownOnUncaught() {} },
});
mock.module("../src/wiring.ts", {
  namedExports: {
    stopWithBackstop: (runtime: DrainRuntime) => {
      backstopRuntime = runtime;
    },
  },
});

const { startHost } = await import("../src/tenancy/host.ts");

beforeEach(() => {
  stoppers = new Map();
  releasers = new Map();
  backstopRuntime = undefined;
  events = [];
  preparationGates = new Map();
  listenerGate = undefined;
  failedActivation = undefined;
});

function restoreSignals(t: TestContext) {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const previous = new Set(signals.flatMap((signal) => process.listeners(signal)));
  t.after(() => {
    for (const signal of signals)
      for (const listener of process.listeners(signal))
        if (!previous.has(listener)) process.removeListener(signal, listener);
  });
  return previous;
}

async function start(t: TestContext): Promise<DrainRuntime> {
  const previous = restoreSignals(t);
  await startHost({ workerOnly: true });
  const shutdown = process.listeners("SIGTERM").find((listener) => !previous.has(listener));
  assert.ok(shutdown);
  shutdown("SIGTERM");
  assert.ok(backstopRuntime);
  return backstopRuntime;
}

for (const workerOnly of [false, true]) {
  test(`host prepares every tenant before activation: workerOnly=${workerOnly}`, async (t) => {
    restoreSignals(t);
    const prepared = Promise.withResolvers<void>();
    const listening = Promise.withResolvers<void>();
    preparationGates.set("healthy", prepared.promise);
    listenerGate = listening.promise;
    const starting = startHost({ workerOnly });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(events.includes("prepare:healthy"));
      assert.equal(
        events.some((event) => event.startsWith("start:")),
        false,
      );
      assert.equal(events.includes("listener:bind"), false);
      prepared.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(events.includes("prepared:healthy"));
      if (!workerOnly) {
        assert.ok(events.includes("listener:bind"));
        assert.equal(
          events.some((event) => event.startsWith("start:")),
          false,
        );
      }
      listening.resolve();
      await starting;
      for (const id of ["broken", "healthy"]) {
        assert.ok(events.indexOf(`start:${id}`) > events.indexOf("prepared:healthy"));
        if (!workerOnly) assert.ok(events.indexOf(`start:${id}`) > events.indexOf("listener:ready"));
      }
    } finally {
      prepared.resolve();
      listening.resolve();
      await starting;
    }
  });
}

test("an activation failure closes the bound listener and stops every prepared tenant", async (t) => {
  restoreSignals(t);
  failedActivation = "healthy";
  await assert.rejects(startHost(), /activation failed/);
  assert.ok(events.includes("listener:ready"));
  assert.ok(events.includes("listener:close"));
  assert.ok(events.includes("stop:broken"));
  assert.ok(events.includes("stop:healthy"));
});

for (const operation of ["stop", "releaseInFlightRuns"] as const) {
  test(`host ${operation} waits for a healthy tenant after another tenant fails`, async (t) => {
    const gate = Promise.withResolvers<void>();
    let healthyFinished = false;
    const failure = new Error("tenant cleanup failed");
    const actions = operation === "stop" ? stoppers : releasers;
    actions.set("broken", async () => {
      throw failure;
    });
    actions.set("healthy", async () => {
      await gate.promise;
      healthyFinished = true;
    });
    const runtime = await start(t);
    const pending = runtime[operation]();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(failure));
      return true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(healthyFinished, false);
      assert.equal(settled, false);
    } finally {
      gate.resolve();
      await rejected;
    }
    assert.equal(healthyFinished, true);
  });
}
