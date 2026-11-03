import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";

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

async function lockWaiter(observer: pg.Client, prefix: string): Promise<number> {
  let pid = 0;
  await until(async () => {
    const { rows } = await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND starts_with(query, $1)",
      [prefix],
    );
    pid = rows[0]?.pid ?? 0;
    return pid !== 0;
  }, `a backend running ${prefix} to wait on the lock`);
  return pid;
}

async function tracedClients(
  store: ReturnType<typeof createPgPool>,
  onQuery: (config: unknown, sent: Promise<unknown>) => void,
) {
  const clients: pg.PoolClient[] = [];
  (await store.pool()).on("connect", (client) => {
    clients.push(client);
    const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    Object.assign(client, {
      query: (...args: unknown[]) => {
        const sent = original(...args);
        onQuery(args[0], sent);
        return sent;
      },
    });
  });
  return clients;
}

test("a write aborted while it waits rolls back once the backend gets the lock", { skip }, async () => {
  const store = createPgPool(url!);
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  try {
    await store.q("DROP TABLE IF EXISTS aborted_rows");
    await store.q("CREATE TABLE aborted_rows(n int)");
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE aborted_rows IN ACCESS EXCLUSIVE MODE");
    const controller = new AbortController();
    const writing = store.q("INSERT INTO aborted_rows VALUES (1)", [], { signal: controller.signal, timeoutMs: 5000 });
    const pid = await lockWaiter(locker, "INSERT INTO aborted_rows");
    controller.abort();
    await assert.rejects(writing, { name: "AbortError" });
    await locker.query("COMMIT");
    await until(
      async () => (await locker.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount === 0,
      "the aborted backend to exit",
    );
    assert.equal((await locker.query("SELECT count(*)::int AS n FROM aborted_rows")).rows[0].n, 0);
  } finally {
    await locker.end();
    await store.close();
  }
});

test(
  "an abort before COMMIT is sent rolls back; one after it is sent returns the committed result",
  { skip },
  async () => {
    const store = createPgPool(url!);
    let controller = new AbortController();
    let abortAfter: (config: unknown) => boolean = () => false;
    await tracedClients(store, (config, sent) => {
      if (!abortAfter(config)) return;
      if (config === "COMMIT") controller.abort();
      else void sent.then(() => controller.abort());
    });
    try {
      await store.q("DROP TABLE IF EXISTS commit_edge_rows");
      await store.q("CREATE TABLE commit_edge_rows(n int)");
      abortAfter = (config) => (config as { text?: string }).text?.startsWith("INSERT") === true;
      await assert.rejects(
        store.q("INSERT INTO commit_edge_rows VALUES (1)", [], { signal: controller.signal, timeoutMs: 5000 }),
        { name: "AbortError" },
      );
      controller = new AbortController();
      abortAfter = (config) => config === "COMMIT";
      const committed = await store.query("INSERT INTO commit_edge_rows VALUES (2)", [], {
        signal: controller.signal,
        timeoutMs: 5000,
      });
      assert.equal(controller.signal.aborted, true);
      assert.equal(committed.rowCount, 1);
      abortAfter = () => false;
      assert.deepEqual(await store.q("SELECT n FROM commit_edge_rows"), [{ n: 2 }]);
    } finally {
      await store.close();
    }
  },
);

test("an aborted query closes its connection while the backend is still blocked", { skip }, async () => {
  const store = createPgPool(url!);
  const clients = await tracedClients(store, () => undefined);
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  try {
    await store.q("DROP TABLE IF EXISTS locked_rows");
    await store.q("CREATE TABLE locked_rows(n int)");
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE locked_rows IN ACCESS EXCLUSIVE MODE");
    const controller = new AbortController();
    const reading = store.q("SELECT * FROM locked_rows", [], { signal: controller.signal });
    await lockWaiter(locker, "SELECT * FROM locked_rows");
    controller.abort();
    await assert.rejects(reading, { name: "AbortError" });
    await until(async () => clients[0]!.connection.stream.destroyed, "the connection to close");
  } finally {
    await locker.end();
    await store.close();
  }
});
