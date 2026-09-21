import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkCapacity } from "../src/runs/work-capacity.ts";
import { createWorker } from "../src/runs/worker.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { TurnResult } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import { createAppHelpers } from "../src/api/app-helpers.ts";
import type { App, AppDeps } from "../src/api/app-types.ts";
import { createErrorLog } from "../src/admin/error-log.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";

const request: OrchestratorInput = {
  actor: { id: "internal:U1", type: "internal" },
  conversation: { kind: "dm", threadRef: "thread", audience: [{ id: "internal:U1", type: "internal" }] },
  origin: { kind: "direct" },
  text: "test",
};
const result: TurnResult = { status: "ok", reply: "done" };

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await sleep(1);
  }
}

test("capacity is bounded, FIFO, abortable and releases each permit once", async () => {
  const capacity = createWorkCapacity(1);
  const first = await capacity.acquire();
  const cancelled = new AbortController();
  const second = capacity.acquire(cancelled.signal);
  const order: number[] = [];
  const third = capacity.acquire().then((release) => {
    order.push(3);
    return release;
  });
  const fourth = capacity.acquire().then((release) => {
    order.push(4);
    return release;
  });
  cancelled.abort();
  assert.equal(await second, null);
  assert.equal(await capacity.acquire(cancelled.signal), null);
  first!();
  first!();
  const releaseThird = await third;
  assert.deepEqual(order, [3]);
  releaseThird!();
  const releaseFourth = await fourth;
  assert.deepEqual(order, [3, 4]);
  releaseFourth!();
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => createWorkCapacity(invalid));
});

test("tenant capacity limits local work without reserving host slots for locally queued work", async () => {
  const host = createWorkCapacity(2);
  const first = createWorkCapacity(1, host);
  const second = createWorkCapacity(2, host);
  const releaseFirst = await first.acquire();
  let firstResumed = false;
  const firstWaiting = first.acquire().then((release) => {
    firstResumed = true;
    return release;
  });
  const releaseSecond = await second.acquire();
  const secondWaiting = second.acquire();
  releaseFirst!();
  releaseFirst!();
  const releaseNextSecond = await secondWaiting;
  assert.equal(firstResumed, false);
  releaseSecond!();
  const releaseNextFirst = await firstWaiting;
  assert.equal(firstResumed, true);
  releaseNextSecond!();
  releaseNextFirst!();
});

test("aborting either capacity queue returns any acquired tenant permit", async () => {
  const host = createWorkCapacity(1);
  const tenant = createWorkCapacity(1, host);
  const releaseHost = await host.acquire();
  const waitingOnHost = new AbortController();
  const pending = tenant.acquire(waitingOnHost.signal);
  await sleep(1);
  waitingOnHost.abort();
  assert.equal(await pending, null);
  releaseHost!();
  const releaseTenant = await tenant.acquire();
  const waitingLocally = new AbortController();
  const local = tenant.acquire(waitingLocally.signal);
  waitingLocally.abort();
  assert.equal(await local, null);
  releaseTenant!();
  const resumed = await tenant.acquire();
  resumed!();
});

test("a failed parent acquisition releases tenant capacity for a later request", async () => {
  let fail = true;
  let released = 0;
  const tenant = createWorkCapacity(1, {
    async acquire() {
      if (fail) throw new Error("capacity unavailable");
      return () => {
        released++;
      };
    },
  });
  await assert.rejects(tenant.acquire(), /capacity unavailable/);
  fail = false;
  const release = await tenant.acquire();
  release!();
  release!();
  assert.equal(released, 1);
});

test("tenant workers share a total cap and a waiting tenant runs before a busy tenant reclaims", async () => {
  const capacity = createWorkCapacity(2);
  const turns: Array<{ tenant: string; finish(): void }> = [];
  const active = new Map<string, number>();
  let maxActive = 0;
  let maxA = 0;
  const workers = [];
  for (const [tenant, count] of [
    ["a", 1],
    ["b", 2],
  ] as const) {
    const { runs } = createMemoryRunStore();
    for (let index = 0; index < 4; index++)
      await runs.enqueue({ sessionId: `${tenant}-${index}`, request, maxAttempts: 3 });
    const orchestrator = {
      handleTurn: () =>
        new Promise<TurnResult>((resolve) => {
          let finished = false;
          active.set(tenant, (active.get(tenant) ?? 0) + 1);
          maxActive = Math.max(
            maxActive,
            [...active.values()].reduce((sum, value) => sum + value, 0),
          );
          maxA = Math.max(maxA, active.get("a") ?? 0);
          turns.push({
            tenant,
            finish() {
              if (finished) return;
              finished = true;
              active.set(tenant, active.get(tenant)! - 1);
              resolve(result);
            },
          });
        }),
    } as unknown as Orchestrator;
    for (let index = 0; index < count; index++)
      workers.push(
        createWorker({
          capacity,
          runs,
          sessions: createMemorySessionStore(),
          orchestrator,
          leaseTtlMs: 10_000,
          pollMs: 5,
        }),
      );
  }
  try {
    for (const worker of workers) worker.start();
    await until(() => turns.length === 2);
    assert.deepEqual(
      turns.map((turn) => turn.tenant),
      ["a", "b"],
    );
    turns[0]!.finish();
    await until(() => turns.length === 3);
    assert.equal(turns[2]!.tenant, "b");
    assert.equal(maxActive, 2);
    assert.equal(maxA, 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.stopClaims()));
    for (const turn of turns) turn.finish();
    await Promise.all(workers.map((worker) => worker.drained()));
  }
  const first = await capacity.acquire();
  const second = await capacity.acquire();
  first!();
  second!();
});

test("stopping a worker awaiting capacity aborts without claiming or holding a permit", async (t) => {
  const capacity = createWorkCapacity(1);
  const release = await capacity.acquire();
  const { runs } = createMemoryRunStore();
  const claim = t.mock.method(runs, "claim");
  const worker = createWorker({
    capacity,
    runs,
    sessions: createMemorySessionStore(),
    orchestrator: { handleTurn: async () => result } as unknown as Orchestrator,
    leaseTtlMs: 10_000,
  });
  worker.start();
  await worker.stopClaims();
  await worker.drained();
  assert.equal(claim.mock.callCount(), 0);
  release!();
  const next = await capacity.acquire();
  next!();
});

test("empty and failed claims return shared capacity before the worker waits", async (t) => {
  for (const fails of [false, true]) {
    const capacity = createWorkCapacity(1);
    const { runs } = createMemoryRunStore();
    const claimed = Promise.withResolvers<void>();
    t.mock.method(runs, "claim", async () => {
      claimed.resolve();
      if (fails) throw new Error("expected claim failure");
      return null;
    });
    const worker = createWorker({
      capacity,
      runs,
      sessions: createMemorySessionStore(),
      orchestrator: { handleTurn: async () => result } as unknown as Orchestrator,
      leaseTtlMs: 10_000,
      pollMs: 20,
    });
    worker.start();
    await claimed.promise;
    const permit = await capacity.acquire();
    assert.ok(permit);
    await worker.stopClaims();
    await worker.drained();
    permit();
  }
});

test("stopping during a claim hands its run back before returning shared capacity", async (t) => {
  const capacity = createWorkCapacity(1);
  const { runs } = createMemoryRunStore();
  const queued = (await runs.enqueue({ sessionId: "session", request, maxAttempts: 3 })).run;
  const claim = runs.claim.bind(runs);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.mock.method(runs, "claim", async (...args: Parameters<typeof runs.claim>) => {
    const run = await claim(...args);
    entered.resolve();
    await finish.promise;
    return run;
  });
  let executed = false;
  const worker = createWorker({
    capacity,
    runs,
    sessions: createMemorySessionStore(),
    orchestrator: {
      handleTurn: async () => {
        executed = true;
        return result;
      },
    } as unknown as Orchestrator,
    leaseTtlMs: 10_000,
  });
  worker.start();
  await entered.promise;
  const stopped = worker.stopClaims();
  finish.resolve();
  await stopped;
  await worker.drained();
  assert.equal(executed, false);
  assert.equal((await runs.get(queued.id))?.status, "pending");
  const permit = await capacity.acquire();
  permit!();
});

test("queued synchronous turns wait for a capacity-limited worker without making inline claims", async (t) => {
  const capacity = createWorkCapacity(1);
  const release = await capacity.acquire();
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const queued = (await runs.enqueue({ sessionId: "queued", request, maxAttempts: 3 })).run;
  const inline = t.mock.method(runs, "claimForSession");
  const deps = {
    runs,
    sessions,
    inlineTurns: false,
    leaseTtlMs: 10_000,
    runWaitMs: 1_000,
    orchestrator: { handleTurn: async () => result } as unknown as Orchestrator,
  };
  const worker = createWorker({ ...deps, capacity });
  const helpers = createAppHelpers(deps as AppDeps, {} as App);
  worker.start();
  try {
    const pending = helpers.drive(queued.id);
    await sleep(10);
    assert.equal(inline.mock.callCount(), 0);
    assert.equal((await runs.get(queued.id))?.status, "pending");
    release!();
    assert.deepEqual(await pending, result);
    assert.equal(inline.mock.callCount(), 0);
    assert.equal((await runs.get(queued.id))?.attempts, 1);
  } finally {
    release!();
    await worker.stop();
  }
});

test("queued synchronous turns time out without consuming a run or bypassing worker capacity", async (t) => {
  const { runs } = createMemoryRunStore();
  const queued = (await runs.enqueue({ sessionId: "queued-timeout", request, maxAttempts: 3 })).run;
  const inline = t.mock.method(runs, "claimForSession");
  const helpers = createAppHelpers(
    { runs, sessions: createMemorySessionStore(), inlineTurns: false, runWaitMs: 20 } as AppDeps,
    {} as App,
  );
  await assert.rejects(helpers.drive(queued.id), /did not finish within 20ms/);
  assert.equal(inline.mock.callCount(), 0);
  assert.equal((await runs.get(queued.id))?.status, "pending");
});

test("inline turns acquire capacity before claiming and abandon the wait at their request deadline", async (t) => {
  const host = createWorkCapacity(1);
  const capacity = createWorkCapacity(1, host);
  const releaseHost = await host.acquire();
  const { runs } = createMemoryRunStore();
  const queued = (await runs.enqueue({ sessionId: "inline-timeout", request, maxAttempts: 3 })).run;
  const inline = t.mock.method(runs, "claimForSession");
  const helpers = createAppHelpers(
    { runs, sessions: createMemorySessionStore(), capacity, runWaitMs: 20 } as AppDeps,
    {} as App,
  );
  try {
    await assert.rejects(helpers.drive(queued.id), /did not finish within 20ms/);
    assert.equal(inline.mock.callCount(), 0);
    assert.equal((await runs.get(queued.id))?.status, "pending");
  } finally {
    releaseHost!();
  }
  const permit = await capacity.acquire();
  permit!();
});

test("inline claims release capacity when claiming fails or finds no eligible work", async (t) => {
  for (const failed of [false, true]) {
    const capacity = createWorkCapacity(1);
    const { runs } = createMemoryRunStore();
    const queued = (await runs.enqueue({ sessionId: "inline-empty", request, maxAttempts: 3 })).run;
    const claimed = Promise.withResolvers<void>();
    t.mock.method(runs, "claimForSession", async () => {
      claimed.resolve();
      if (failed) throw new Error("claim failed");
      return null;
    });
    const helpers = createAppHelpers(
      { runs, sessions: createMemorySessionStore(), capacity, runWaitMs: 20 } as AppDeps,
      {} as App,
    );
    const waiting = helpers.drive(queued.id);
    const rejected = assert.rejects(waiting, failed ? /claim failed/ : /did not finish within 20ms/);
    await claimed.promise;
    const release = await capacity.acquire();
    assert.ok(release);
    await rejected;
    release();
  }
});

test("a hosted tenant survives repeated claim failures, reports sparsely and releases capacity for healthy tenants", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
  const capacity = createWorkCapacity(1);
  const errors = createErrorLog();
  const failing = createMemoryRunStore();
  let failures = 0;
  t.mock.method(failing.runs, "claim", async () => {
    failures++;
    throw new Error("tenant database unavailable");
  });
  const healthy = createMemoryRunStore();
  const queued = (await healthy.runs.enqueue({ sessionId: "healthy", request })).run;
  let healthyTurns = 0;
  const context = createTenantContext({ id: "failed-tenant", env: {}, pooled: true });
  const failedWorker = runWithTenant(context, () =>
    createWorker({
      capacity: createWorkCapacity(1, capacity),
      errors,
      runs: failing.runs,
      sessions: createMemorySessionStore(),
      orchestrator: { handleTurn: async () => result } as unknown as Orchestrator,
      leaseTtlMs: 10_000,
      pollMs: 1,
    }),
  );
  const healthyWorker = createWorker({
    capacity: createWorkCapacity(1, capacity),
    runs: healthy.runs,
    sessions: createMemorySessionStore(),
    orchestrator: {
      async handleTurn() {
        healthyTurns++;
        return result;
      },
    } as unknown as Orchestrator,
    leaseTtlMs: 10_000,
  });
  failedWorker.start();
  healthyWorker.start();
  try {
    for (let index = 0; index < 60 && failures < 22; index++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(5_000);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(failures >= 22 && failures < 40);
    assert.equal(healthyTurns, 1);
    assert.equal((await healthy.runs.get(queued.id))?.status, "done");
    assert.equal(messages.filter((message) => message.includes("worker: claim failed")).length, 2);
    const recorded = await errors.list();
    assert.equal(recorded.length, 2);
    assert.ok(
      recorded.every((entry) => entry.code === "worker_claim_failed" && entry.scopeLabel === "org:failed-tenant"),
    );
  } finally {
    await Promise.all([failedWorker.stopClaims(), healthyWorker.stopClaims()]);
    await Promise.all([failedWorker.drained(), healthyWorker.drained()]);
  }
});
