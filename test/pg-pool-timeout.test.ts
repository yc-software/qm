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
    return { ...rows[0], status: (client as unknown as { getTransactionStatus(): string }).getTransactionStatus() };
  } finally {
    client.release();
  }
}

test("a query with a timeout returns what the same query returns without one", { skip }, async () => {
  const store = createPgPool(url!);
  try {
    const text = `SELECT $1::int8 AS big, $2::numeric AS num, $3::timestamptz AS at, $4::jsonb AS doc, $5::int[] AS ints,
      $6::bytea AS bin, $7::bool AS flag, $8::text AS nothing FROM generate_series(1, 3)`;
    const values = [
      "9007199254740993",
      "1.10",
      new Date(0),
      JSON.stringify({ a: [1] }),
      [1, 2],
      Buffer.from("hi"),
      true,
      null,
    ];
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

test("the statement timeout fires as 57014 and never reaches the next borrower", { skip }, async () => {
  const store = createPgPool(url!);
  try {
    await assert.rejects(store.q("SELECT pg_sleep(1)", [], { timeoutMs: 30 }), { code: "57014" });
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
