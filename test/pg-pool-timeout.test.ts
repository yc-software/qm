import assert from "node:assert/strict";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { test } from "node:test";
import pg from "pg";
import { configurePgPooling, createPgPool, withPgTransaction } from "../src/persistence/pg-pool.ts";

const url = process.env.DATABASE_URL;
const skip = url ? false : "set DATABASE_URL (a Postgres) to run the query timeout tests";
configurePgPooling({ queryMax: 1 });

async function connectionState(store: ReturnType<typeof createPgPool>) {
  const client = await (await store.pool()).connect();
  try {
    const { rows } = await client.query(
      "SELECT current_setting('statement_timeout') AS timeout, now() = statement_timestamp() AS fresh, pg_backend_pid() AS pid",
    );
    return { ...rows[0], status: client.getTransactionStatus() };
  } finally {
    client.release();
  }
}

test("a query with a timeout returns what the same query returns without one", { skip }, async () => {
  const store = createPgPool(url!);
  try {
    const text = "SELECT $1::int8 AS big, $2::jsonb AS doc FROM generate_series(1, 3)";
    const values = ["9007199254740993", JSON.stringify({ a: [1] })];
    assert.deepEqual(await store.query(text, values, { timeoutMs: 1000 }), await store.query(text, values));
    await store.q("DROP TABLE IF EXISTS timeout_rows");
    await store.q("CREATE TABLE timeout_rows(n int)");
    assert.equal(
      (await store.query("INSERT INTO timeout_rows SELECT generate_series(1, $1::int)", [4], { timeoutMs: 1000 }))
        .rowCount,
      4,
    );
    await assert.rejects(store.q("SELECT 1 / $1::int", [0], { timeoutMs: 1000 }), (error) => {
      return error instanceof pg.DatabaseError && error.code === "22012";
    });
    await assert.rejects(store.q("INSERT INTO timeout_rows VALUES (1), (1 / $1::int)", [0], { timeoutMs: 1000 }), {
      code: "22012",
    });
    assert.equal((await store.q("SELECT count(*)::int AS n FROM timeout_rows"))[0]!.n, 4);
    assert.deepEqual(
      await store.query("SELECT 1 AS a; SELECT 2 AS b", [], { timeoutMs: 1000 }),
      await store.query("SELECT 1 AS a; SELECT 2 AS b"),
    );
    assert.deepEqual(await connectionState(store).then(({ timeout, fresh, status }) => ({ timeout, fresh, status })), {
      timeout: "0",
      fresh: true,
      status: "I",
    });
  } finally {
    await store.close();
  }
});

test("a caller BEGIN cannot leave the pooled connection inside a transaction", { skip }, async () => {
  const store = createPgPool(url!);
  try {
    await store.q("BEGIN", [], { timeoutMs: 1000 });
    const state = await connectionState(store);
    assert.deepEqual([state.timeout, state.fresh, state.status], ["0", true, "I"]);
    assert.equal((await store.q("SELECT pg_backend_pid() AS pid"))[0]!.pid, state.pid);
  } finally {
    await store.close();
  }
});

test("a backend terminated mid-query rejects and the pool replaces the connection", { skip }, async () => {
  const store = createPgPool(url!);
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const pid = (await store.q("SELECT pg_backend_pid() AS pid", [], { timeoutMs: 5000 }))[0]!.pid;
    const sleeping = assert.rejects(store.q("SELECT pg_sleep(5)", [], { timeoutMs: 10_000 }));
    for (let i = 0; i < 250; i++) {
      const { rows } = await observer.query("SELECT query FROM pg_stat_activity WHERE pid = $1", [pid]);
      if (rows[0]?.query === "SELECT pg_sleep(5)") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await observer.query("SELECT pg_terminate_backend($1)", [pid]);
    await sleeping;
    const next = (await store.q("SELECT pg_backend_pid() AS pid", [], { timeoutMs: 5000 }))[0]!;
    assert.notEqual(next.pid, pid);
    assert.equal((await connectionState(store)).status, "I");
  } finally {
    await observer.end();
    await store.close();
  }
});

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function activity(observer: pg.Client, text: string, values: unknown[]) {
  await observer.query("SELECT pg_stat_clear_snapshot()");
  return observer.query(text, values);
}

async function lockWaiter(observer: pg.Client, prefix: string): Promise<number> {
  let pid = 0;
  await until(async () => {
    const { rows } = await activity(
      observer,
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND starts_with(query, $1)",
      [prefix],
    );
    pid = rows[0]?.pid ?? 0;
    return pid !== 0;
  }, `a backend running ${prefix} to wait on the lock`);
  return pid;
}

test("an abort before COMMIT is sent rolls back even when the cancel cannot reach the server", { skip }, async () => {
  const target = new URL(url!);
  const sockets = new Set<Socket>();
  const proxy = createServer((socket) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const end of [socket, upstream]) {
      sockets.add(end);
      end.on("error", () => undefined);
      end.on("close", () => [socket, upstream].forEach((other) => other.destroy()));
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxied = new URL(url!);
  proxied.hostname = "127.0.0.1";
  proxied.port = String((proxy.address() as AddressInfo).port);
  const store = createPgPool(proxied.toString());
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  try {
    await store.q("DROP TABLE IF EXISTS aborted_rows");
    await store.q("CREATE TABLE aborted_rows(n int PRIMARY KEY)");
    await locker.query("BEGIN");
    await locker.query("INSERT INTO aborted_rows VALUES (1)");
    const controller = new AbortController();
    const writing = store.q("INSERT INTO aborted_rows VALUES (1)", [], { signal: controller.signal });
    const pid = await lockWaiter(locker, "INSERT INTO aborted_rows");
    proxy.close();
    controller.abort();
    await assert.rejects(writing, { name: "AbortError" });
    await until(async () => (await store.pool()).totalCount === 0, "the pool to drop the connection");
    await locker.query("ROLLBACK");
    await until(
      async () => (await activity(locker, "SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount === 0,
      "the aborted backend to exit",
    );
    assert.equal((await locker.query("SELECT count(*)::int AS n FROM aborted_rows")).rows[0].n, 0);
  } finally {
    await locker.end();
    await store.close();
    sockets.forEach((socket) => socket.destroy());
  }
});

test("an abort after COMMIT is sent returns the committed result", { skip }, async () => {
  const store = createPgPool(url!);
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  try {
    await store.q("DROP TABLE IF EXISTS commit_edge_rows");
    await store.q("CREATE TABLE commit_edge_rows(n int UNIQUE DEFERRABLE INITIALLY DEFERRED)");
    await locker.query("BEGIN");
    await locker.query("INSERT INTO commit_edge_rows VALUES (1)");
    const controller = new AbortController();
    const writing = store.query("INSERT INTO commit_edge_rows VALUES (1)", [], { signal: controller.signal });
    await lockWaiter(locker, "COMMIT");
    controller.abort();
    await locker.query("ROLLBACK");
    assert.equal((await writing).rowCount, 1);
    assert.deepEqual(await store.q("SELECT n FROM commit_edge_rows"), [{ n: 1 }]);
  } finally {
    await locker.end();
    await store.close();
  }
});

test(
  "an aborted query cancels its backend and closes its connection while the table stays locked",
  { skip },
  async () => {
    const store = createPgPool(url!);
    const locker = new pg.Client({ connectionString: url });
    await locker.connect();
    try {
      await store.q("DROP TABLE IF EXISTS locked_rows");
      await store.q("CREATE TABLE locked_rows(n int)");
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE locked_rows IN ACCESS EXCLUSIVE MODE");
      const controller = new AbortController();
      const reading = store.q("SELECT * FROM locked_rows", [], { signal: controller.signal });
      const pid = await lockWaiter(locker, "SELECT * FROM locked_rows");
      controller.abort();
      await assert.rejects(reading, { name: "AbortError" });
      await until(
        async () => (await activity(locker, "SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount === 0,
        "the aborted backend to exit",
      );
    } finally {
      await locker.end();
      await store.close();
    }
  },
);

test("caught database errors keep the pooled connection", { skip }, async () => {
  const store = createPgPool(url!);
  try {
    await store.q("DROP TABLE IF EXISTS unique_rows");
    await store.q("CREATE TABLE unique_rows(n int PRIMARY KEY)");
    await store.q("INSERT INTO unique_rows VALUES (1)");
    const pids = new Set<number>();
    for (const options of [{ timeoutMs: 1000 }, { timeoutMs: 1000, signal: new AbortController().signal }]) {
      await assert.rejects(store.q("INSERT INTO unique_rows VALUES (1)", [], options), { code: "23505" });
      pids.add((await store.q("SELECT pg_backend_pid() AS pid", [], options))[0]!.pid as number);
    }
    assert.equal(pids.size, 1);
    assert.equal((await connectionState(store)).status, "I");
  } finally {
    await store.close();
  }
});

test("withPgTransaction enforces idle-in-transaction timeout when client hangs", { skip }, async () => {
  configurePgPooling({ idleInTransactionTimeoutMs: 150 });
  const store = createPgPool(url!);
  try {
    await assert.rejects(
      withPgTransaction(await store.pool(), async (client) => {
        await client.query("SELECT 1");
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 300);
        await promise;
        await client.query("SELECT 2");
      }),
      (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        return /idle-in-transaction|connection error|queryable/i.test(msg);
      },
    );
  } finally {
    configurePgPooling({ idleInTransactionTimeoutMs: 60_000 });
    await store.close();
  }
});
