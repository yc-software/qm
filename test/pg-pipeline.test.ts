import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import type { PoolClient } from "pg";
import { pipelinedQuery } from "../src/persistence/pg-pipeline.ts";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";

const url = process.env.DATABASE_URL;
const skip = url ? false : "set DATABASE_URL (a Postgres) to run the pipelined query tests";
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : undefined;
after(() => pool?.end());

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  let failed: Error | undefined;
  try {
    return await fn(client);
  } catch (error) {
    failed = error as Error;
    throw error;
  } finally {
    client.release(failed);
  }
}

async function assertClean(client: PoolClient): Promise<void> {
  const { rows } = await client.query(
    "SELECT current_setting('qm.pipeline_probe', true) AS probe, current_setting('statement_timeout') AS timeout, current_user = session_user AS self",
  );
  assert.ok(!rows[0].probe, "no setting outlives the pipeline");
  assert.deepEqual([rows[0].timeout, rows[0].self], ["0", true]);
  assert.equal((client as unknown as { getTransactionStatus(): string }).getTransactionStatus(), "I");
}

test("the pipeline sends prefix and query in one corked write ending in a single Sync", async () => {
  const calls: string[] = [];
  const connection = {
    stream: { cork: () => calls.push("cork"), uncork: () => calls.push("uncork") },
    parsedStatements: {},
    ...Object.fromEntries(
      ["parse", "bind", "describe", "execute", "sync", "flush", "close"].map((name) => [name, () => calls.push(name)]),
    ),
  };
  let submitted: Record<string, (...args: unknown[]) => unknown> | undefined;
  const client = {
    query: (query: Record<string, (...args: unknown[]) => unknown>) => {
      submitted = query;
      assert.equal(query.submit!(connection), null);
    },
  } as unknown as PoolClient;
  const result = pipelinedQuery(client, [["qm.pipeline_probe", "a"]], "SELECT $1::int AS n", [7]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    "cork",
    "parse",
    "bind",
    "execute",
    "cork",
    "parse",
    "bind",
    "describe",
    "execute",
    "sync",
    "uncork",
    "uncork",
  ]);
  const query = submitted!;
  query.handleDataRow!({ fields: ["a"] });
  query.handleCommandComplete!({ text: "SELECT 1" }, connection);
  query.handleRowDescription!({ fields: [{ name: "n", dataTypeID: 23, format: "text" }] });
  query.handleDataRow!({ fields: ["7"] });
  query.handleCommandComplete!({ text: "SELECT 1" }, connection);
  query.handleReadyForQuery!(connection);
  const { rows, rowCount, command } = await result;
  assert.deepEqual({ rows, rowCount, command }, { rows: [{ n: 7 }], rowCount: 1, command: "SELECT" });
});

test("pipelined results match client.query rows, types, fields and counts", { skip }, async () => {
  await withClient(async (client) => {
    const text = `SELECT $1::int8 AS big, $2::numeric AS num, $3::timestamptz AS at, $4::jsonb AS doc,
      $5::int[] AS ints, $6::bytea AS bin, $7::bool AS flag, $8::text AS nothing, 'x'::text AS literal,
      interval '1 day' AS span, 1.5::float8 AS float FROM generate_series(1, 3) AS g`;
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
    const plain = await client.query({ text, values });
    const piped = await pipelinedQuery(client, [["qm.pipeline_probe", "a"]], text, values);
    assert.deepEqual(piped.rows, plain.rows);
    assert.deepEqual([piped.rowCount, piped.command, piped.fields], [plain.rowCount, plain.command, plain.fields]);
    await client.query("CREATE TEMP TABLE pipeline_dml(n int)");
    const insert = await pipelinedQuery(
      client,
      [["statement_timeout", "1000"]],
      "INSERT INTO pipeline_dml SELECT generate_series(1, $1::int)",
      [4],
    );
    assert.deepEqual([insert.rowCount, insert.command, insert.rows], [4, "INSERT", []]);
    await assertClean(client);
  });
});

test("an error in the prefix rejects with the server error and runs nothing", { skip }, async () => {
  await withClient(async (client) => {
    await client.query("CREATE TEMP TABLE pipeline_prefix(n int)");
    await assert.rejects(
      pipelinedQuery(client, [["statement_timeout", "soon"]], "INSERT INTO pipeline_prefix VALUES (1)", []),
      (error: Error & { code?: string }) => error instanceof pg.DatabaseError && error.code === "22023",
    );
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pipeline_prefix")).rows[0].n, 0);
    await assertClean(client);
  });
});

test("an error in the query rolls back the prefix and leaves the connection idle", { skip }, async () => {
  await withClient(async (client) => {
    await client.query("CREATE TEMP TABLE pipeline_query(n int)");
    await assert.rejects(
      pipelinedQuery(client, [["qm.pipeline_probe", "a"]], "INSERT INTO pipeline_query VALUES (1), (1 / $1::int)", [0]),
      (error: Error & { code?: string }) => error instanceof pg.DatabaseError && error.code === "22012",
    );
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pipeline_query")).rows[0].n, 0);
    await assert.rejects(pipelinedQuery(client, [["qm.pipeline_probe", "a"]], "SELECT 1; SELECT 2", []), {
      code: "42601",
    });
    await assertClean(client);
  });
});

test("a backend killed mid-pipeline rejects and the pool replaces the connection", { skip }, async () => {
  configurePgPooling({ queryMax: 1 });
  const store = createPgPool(url!);
  try {
    const pid = (await store.q("SELECT pg_backend_pid() AS pid", [], { timeoutMs: 5000 }))[0]!.pid;
    const sleeping = store.q("SELECT pg_sleep(5)", [], { timeoutMs: 10_000 });
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool!.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [pid]);
      if (rows[0]?.state === "active") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await pool!.query("SELECT pg_terminate_backend($1)", [pid]);
    await assert.rejects(sleeping);
    const [next] = await store.q("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS t", [], {
      timeoutMs: 5000,
    });
    assert.notEqual(next!.pid, pid);
    assert.equal(next!.t, "5s");
  } finally {
    await store.close();
  }
});

test("the statement timeout fires as 57014 and does not reach the next query on the connection", { skip }, async () => {
  const store = createPgPool(url!);
  try {
    await assert.rejects(store.q("SELECT pg_sleep(1)", [], { timeoutMs: 30 }), { code: "57014" });
    assert.equal((await store.q("SHOW statement_timeout"))[0]!.statement_timeout, "0");
  } finally {
    await store.close();
  }
  await withClient(async (client) => {
    await assert.rejects(pipelinedQuery(client, [["statement_timeout", "30"]], "SELECT pg_sleep(1)", []), {
      code: "57014",
    });
    await client.query("SELECT pg_sleep(0.1)");
    await assertClean(client);
  });
});

test("row-level security sees each tenant from the prefix and nothing stays on the connection", { skip }, async () => {
  const role = `qm_pipeline_${randomBytes(4).toString("hex")}`;
  await pool!.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    await withClient(async (client) => {
      await client.query("CREATE TEMP TABLE pipeline_rls(tenant text, n int)");
      await client.query("INSERT INTO pipeline_rls VALUES ('a', 1), ('a', 2), ('b', 3)");
      await client.query("ALTER TABLE pipeline_rls ENABLE ROW LEVEL SECURITY");
      await client.query(
        "CREATE POLICY pipeline_rls_tenant ON pipeline_rls USING (tenant = current_setting('qm.pipeline_probe', true))",
      );
      await client.query(`GRANT USAGE ON SCHEMA pg_temp TO ${role}`).catch(() => undefined);
      await client.query(`GRANT SELECT ON pipeline_rls TO ${role}`);
      const as = async (tenant: string) =>
        (
          await pipelinedQuery(
            client,
            [
              ["role", role],
              ["qm.pipeline_probe", tenant],
            ],
            "SELECT n FROM pipeline_rls ORDER BY n",
            [],
          )
        ).rows.map((row) => row.n);
      assert.deepEqual(await as("a"), [1, 2]);
      assert.deepEqual(await as("b"), [3]);
      assert.deepEqual(await as("c"), []);
      await assertClean(client);
      await client.query("DROP TABLE pipeline_rls");
    });
  } finally {
    await pool!.query(`DROP ROLE ${role}`);
  }
});
