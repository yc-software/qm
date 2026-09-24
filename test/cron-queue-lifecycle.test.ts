import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

type ListenerClient = EventEmitter & {
  query(text: string): Promise<unknown>;
  release(destroy?: boolean): void;
};
type Adapter = {
  executeSql(text: string, values?: unknown[]): Promise<unknown>;
  listen?: (
    channel: string,
    onNotification: (payload: string) => void,
    onReconnect: () => void,
  ) => Promise<{
    close(): Promise<void>;
  }>;
};
const pools: { closed: boolean }[] = [];
let adapter: Adapter;
let hasListen = false;
let useListenNotify: boolean | undefined;
let sessionClient: ListenerClient | undefined;
let sessionQueries: string[] = [];
let sessionReleased = false;
let failStart = false;
let failWork = false;
let emitError: (e: Error) => void = () => {};

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
        sessionPool: async () => ({
          connect: async () => {
            const client = Object.assign(new EventEmitter(), {
              query: async (text: string) => {
                sessionQueries.push(text);
                return { rows: [] };
              },
              release: () => {
                sessionReleased = true;
              },
            }) as ListenerClient;
            sessionClient = client;
            return client;
          },
        }),
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
      constructor(options: { db: Adapter; useListenNotify?: boolean }) {
        adapter = options.db;
        hasListen = typeof options.db.listen === "function";
        useListenNotify = options.useListenNotify;
      }
      on(_event: string, listener: (e: Error) => void) {
        emitError = listener;
      }
      async start() {
        await adapter.executeSql("SELECT 1");
        if (failStart) throw new Error("startup failed");
      }
      async createQueue() {}
      async work() {
        if (failWork) throw new Error("polling failed");
      }
      async offWork() {}
      async stop() {}
    },
  },
});

const { createPgBossCronQueue } = await import("../src/cron/job-queue.ts");
const handlers = { onFire: async () => {} };

test("pg-boss enables LISTEN/NOTIFY for cron queues", () => {
  createPgBossCronQueue("postgres://unused");
  assert.equal(useListenNotify, true);
  assert.equal(hasListen, true);
});

test("pg-boss forwards notifications from a pinned session", async () => {
  sessionQueries = [];
  sessionReleased = false;
  const queue = createPgBossCronQueue("postgres://unused");
  await queue.start(handlers, 60_000);
  const received: string[] = [];
  let reconnects = 0;
  const listener = await adapter.listen!(
    "pgboss_test",
    (payload) => received.push(payload),
    () => reconnects++,
  );
  try {
    assert.deepEqual(sessionQueries, ['LISTEN "pgboss_test"']);
    assert.equal(reconnects, 1);
    sessionClient!.emit("notification", { payload: "cron-fire" });
    assert.deepEqual(received, ["cron-fire"]);
  } finally {
    await listener.close();
    await queue.stop();
  }
  assert.equal(sessionReleased, true);
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
