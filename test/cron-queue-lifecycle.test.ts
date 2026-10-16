import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Adapter = { executeSql(text: string, values?: unknown[]): Promise<unknown> };
const pools: { closed: boolean }[] = [];
let adapter: Adapter;
let failStart = false;
let failWork = false;
let emitError: (e: Error) => void = () => {};
let wip: { name: string; count: number }[] = [];
let onFetch: (jobs: { data: { cronId: string; scheduledAt: number }; signal: AbortSignal }[]) => Promise<void>;

mock.module("../src/persistence/pg-pool.ts", {
  namedExports: {
    createPgPool: () => {
      const state = { closed: false };
      pools.push(state);
      return {
        pool: async () => {
          if (state.closed) throw new Error("Postgres store is closed");
          return { query: async () => ({ rows: [] }) };
        },
        close: async () => {
          state.closed = true;
        },
      };
    },
  },
});

mock.module("pg-boss", {
  namedExports: {
    PgBoss: class {
      constructor(options: { db: Adapter }) {
        adapter = options.db;
      }
      on(_event: string, listener: (e: Error) => void) {
        emitError = listener;
      }
      async start() {
        await adapter.executeSql("SELECT 1");
        if (failStart) throw new Error("startup failed");
      }
      async createQueue() {}
      async work(_name: string, _options: unknown, callback: typeof onFetch) {
        if (failWork) throw new Error("polling failed");
        onFetch = callback;
      }
      getWipData() {
        return wip;
      }
      async offWork() {}
      async stop() {}
    },
  },
});

const { createPgBossCronQueue } = await import("../src/cron/job-queue.ts");
const handlers = { onFire: async () => {} };

test("pausing waits for in-flight fetches but does not drain admitted work", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  const done = Promise.withResolvers<void>();
  let calls = 0;
  let finished = false;
  await queue.start({
    onFire: async () => {
      calls++;
      await done.promise;
      finished = true;
    },
  });
  wip = [{ name: "cron-fire", count: 0 }];
  let paused = false;
  const stopping = queue.stopClaims!().then(() => {
    paused = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(paused, false);
    wip[0]!.count = 1;
    const running = onFetch([{ data: { cronId: "late", scheduledAt: 1 }, signal: new AbortController().signal }]);
    await stopping;
    assert.equal(calls, 1);
    assert.equal(finished, false);
    done.resolve();
    await running;
    assert.equal(finished, true);
  } finally {
    wip = [];
    done.resolve();
    await stopping;
    await queue.stop();
  }
});

test("pausing waits for an empty fetch to retire before admitting new deliveries", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers);
  wip = [{ name: "cron-fire", count: 0 }];
  let paused = false;
  const stopping = queue.stopClaims!().then(() => {
    paused = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(paused, false);
    wip = [];
    await stopping;
    assert.equal(paused, true);
  } finally {
    wip = [];
    await stopping;
    await queue.stop();
  }
});

test("late worker SQL after stop cannot reopen the queue database", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers);
  await queue.stop();
  const count = pools.length;
  await assert.rejects(adapter.executeSql("SELECT 1"), /closed/);
  assert.equal(pools.length, count);
  assert.ok(pools.at(-1)?.closed);
  await queue.start(handlers);
  try {
    assert.equal(pools.length, count + 1);
    await adapter.executeSql("SELECT 1");
    assert.ok(queue.healthy());
  } finally {
    await queue.stop();
  }
});

test("startup failure closes the database and permits a fresh start", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  failStart = true;
  try {
    await assert.rejects(queue.start(handlers), /startup failed/);
    assert.ok(pools.at(-1)?.closed);
    assert.equal(queue.healthy(), false);
    await assert.rejects(adapter.executeSql("SELECT 1"), /closed/);
  } finally {
    failStart = false;
  }
  await queue.start(handlers);
  try {
    assert.equal(pools.at(-1)?.closed, false);
    assert.ok(queue.healthy());
  } finally {
    await queue.stop();
  }
});

test("resuming polling failure preserves the database for admitted callbacks", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers);
  await queue.stopClaims!();
  const count = pools.length;
  failWork = true;
  try {
    await assert.rejects(queue.start(handlers), /polling failed/);
    assert.equal(queue.healthy(), false);
    assert.equal(pools.at(-1)?.closed, false);
    await adapter.executeSql("SELECT 1");
  } finally {
    failWork = false;
  }
  try {
    await queue.start(handlers);
    assert.equal(pools.length, count);
    assert.ok(queue.healthy());
  } finally {
    await queue.stop();
  }
  assert.ok(pools.at(-1)?.closed);
});

test("a pg-boss error marks the queue unhealthy without any synthetic send", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers);
  try {
    assert.ok(queue.healthy());
    emitError(new Error("fetch failed"));
    assert.equal(queue.healthy(), false);
  } finally {
    await queue.stop();
  }
});
