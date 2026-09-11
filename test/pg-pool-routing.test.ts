import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool, configurePgPooling } from "../src/persistence/pg-pool.ts";

const direct = process.env.DATABASE_URL;
const pooled = process.env.DATABASE_POOL_URL;
const pooling = {
  ...(direct ? { databaseUrl: direct } : {}),
  ...(pooled ? { poolUrl: pooled } : {}),
  ...(process.env.DATABASE_POOL_CA_CERT ? { caCert: process.env.DATABASE_POOL_CA_CERT } : {}),
  queryMax: Number(process.env.DATABASE_POOL_MAX ?? 4),
  sessionMax: Number(process.env.DATABASE_DIRECT_POOL_MAX ?? 1),
};
configurePgPooling(pooling);
const skip = !direct || !pooled ? "requires direct Postgres and transaction PgBouncer URLs" : false;

test("stores share the query pool and closing one does not close another", { skip }, async () => {
  const a = createPgPool(direct!);
  const b = createPgPool(direct!);
  try {
    assert.equal(await a.pool(), await b.pool());
    await a.close();
    assert.equal((await b.q("SELECT 42 AS answer"))[0]!.answer, 42);
  } finally {
    await a.close();
    await b.close();
  }
});

test("pooled query timeout rolls back without contaminating the next borrower", { skip }, async () => {
  const a = createPgPool(direct!);
  try {
    await assert.rejects(a.q("SELECT pg_sleep(0.2)", [], { timeoutMs: 20 }), { code: "57014" });
    assert.equal((await a.q("SHOW statement_timeout"))[0]!.statement_timeout, "0");
    await a.q("SELECT pg_sleep(0.05)");
    assert.equal((await a.q("SELECT 42 AS answer", [], { timeoutMs: 1000 }))[0]!.answer, 42);
    assert.equal((await a.q("SHOW statement_timeout"))[0]!.statement_timeout, "0");
  } finally {
    await a.close();
  }
});

test("session operations remain direct while ordinary queries use another backend", { skip }, async () => {
  const a = createPgPool(direct!);
  const client = await (await a.sessionPool()).connect();
  try {
    assert.equal(new URL((await a.pool()).options.connectionString!).port, new URL(pooled!).port);
    const directPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await client.query("LISTEN qm_pool_routing_test");
    await client.query("SELECT pg_advisory_lock(827360194)");
    const result = await a.q("SELECT pg_backend_pid() AS pid, pg_try_advisory_xact_lock(827360194) AS acquired");
    assert.notEqual(result[0]!.pid, directPid);
    assert.equal(result[0]!.acquired, false);
  } finally {
    await client.query("SELECT pg_advisory_unlock(827360194)");
    await client.query("UNLISTEN qm_pool_routing_test");
    client.release();
    await a.close();
  }
});

test("pooled credentials cannot silently change company identity", { skip }, () => {
  const previous = process.env.DATABASE_POOL_URL;
  const url = new URL(previous!);
  url.pathname = "/another_company";
  configurePgPooling({ ...pooling, poolUrl: url.toString() });
  try {
    assert.throws(() => createPgPool(direct!), /preserve.*database and credentials/);
  } finally {
    configurePgPooling(pooling);
  }
});

test("one session slot can hold a lock while a transaction uses the query pool", { skip }, async () => {
  const a = createPgPool(direct!);
  const lock = createPostgresAdvisoryLock(a);
  const map = createPostgresMap<{ n: number }>(a, "pgbouncer_lock_write_test");
  try {
    await lock.withLock("pgbouncer-write", async () => {
      await map.put("one", { n: 42 });
      assert.deepEqual(await map.get("one"), { n: 42 });
    });
  } finally {
    await a.close();
  }
});

test("concurrent client queries multiplex onto one configured server connection", { skip }, async () => {
  const a = createPgPool(direct!);
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => a.q("SELECT pg_backend_pid() AS pid, pg_sleep(0.01)")),
    );
    assert.equal(new Set(results.map((rows) => rows[0]!.pid)).size, 1);
  } finally {
    await a.close();
  }
});

test("closing during initialization rejects pending queries and leaves other stores usable", { skip }, async () => {
  const a = createPgPool(direct!);
  const b = createPgPool(direct!);
  const pending = assert.rejects(a.q("SELECT 1"), /closed/);
  await a.close();
  await pending;
  await assert.rejects(a.pool(), /closed/);
  try {
    assert.equal((await b.q("SELECT 42 AS answer"))[0]!.answer, 42);
  } finally {
    await b.close();
  }
});

test("dynamic migration waits for its prerequisite schema on a fresh database", { skip }, async () => {
  const a = createPgPool(direct!, "pool-routing/prerequisite/0001", [
    "CREATE TABLE IF NOT EXISTS pool_routing_prerequisite(id INTEGER PRIMARY KEY)",
  ]);
  try {
    await a.migrate({
      id: "pool-routing/prerequisite/0002",
      statements: ["ALTER TABLE pool_routing_prerequisite ADD COLUMN IF NOT EXISTS value TEXT"],
    });
    await a.q(
      "INSERT INTO pool_routing_prerequisite(id, value) VALUES (1, 'ready') ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value",
    );
    assert.equal((await a.q("SELECT value FROM pool_routing_prerequisite WHERE id=1"))[0]!.value, "ready");
  } finally {
    await a.close();
  }
});
