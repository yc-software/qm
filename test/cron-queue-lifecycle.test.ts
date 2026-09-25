import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Adapter = { executeSql(text: string, values?: unknown[]): Promise<unknown> };
const pools: { closed: boolean }[] = [];
let adapter: Adapter;
let failStart = false;
let failWork = false;

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
      on() {}
      async start() {
        await adapter.executeSql("SELECT 1");
        if (failStart) throw new Error("startup failed");
      }
      async createQueue() {}
      async work() {
        if (failWork) throw new Error("polling failed");
      }
      async offWork() {}
      async send() {
        await adapter.executeSql("SELECT 1");
      }
      async stop() {}
    },
  },
});

const { createPgBossCronQueue } = await import("../src/cron/job-queue.ts");
const handlers = { onFire: async () => {}, onTick: async () => {} };

test("late worker SQL after stop cannot reopen the queue database", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers, 60_000);
  await queue.stop();
  const count = pools.length;
  await assert.rejects(adapter.executeSql("SELECT 1"), /closed/);
  assert.equal(pools.length, count);
  assert.ok(pools.at(-1)?.closed);
  await queue.start(handlers, 60_000);
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
    await assert.rejects(queue.start(handlers, 60_000), /startup failed/);
    assert.ok(pools.at(-1)?.closed);
    assert.equal(queue.healthy(), false);
    await assert.rejects(adapter.executeSql("SELECT 1"), /closed/);
  } finally {
    failStart = false;
  }
  await queue.start(handlers, 60_000);
  try {
    assert.equal(pools.at(-1)?.closed, false);
    assert.ok(queue.healthy());
  } finally {
    await queue.stop();
  }
});

test("resuming polling failure preserves the database for admitted callbacks", async () => {
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers, 60_000);
  await queue.stopClaims!();
  const count = pools.length;
  failWork = true;
  try {
    await assert.rejects(queue.start(handlers, 60_000), /polling failed/);
    assert.equal(queue.healthy(), false);
    assert.equal(pools.at(-1)?.closed, false);
    await adapter.executeSql("SELECT 1");
  } finally {
    failWork = false;
  }
  try {
    await queue.start(handlers, 60_000);
    assert.equal(pools.length, count);
    assert.ok(queue.healthy());
  } finally {
    await queue.stop();
  }
  assert.ok(pools.at(-1)?.closed);
});
