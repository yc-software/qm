import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { applyPgMigrations, definePgMigration, withPgTransaction } from "../src/persistence/pg-pool.ts";

function fakePool(rollback: () => Promise<void>) {
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql === "ROLLBACK") await rollback();
      return { rows: [] };
    },
    release: (value?: unknown) => {
      released.push(value);
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, released };
}

test("a failed ROLLBACK keeps the original error and discards the connection", async () => {
  const failure = new Error("operation failed");
  const { pool, released } = fakePool(async () => {
    throw new Error("connection lost");
  });
  await assert.rejects(
    withPgTransaction(pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error);
  assert.equal((released[0] as Error).message, "connection lost");
});

test("a successful ROLLBACK returns the connection to the pool", async () => {
  const failure = new Error("operation failed");
  const { pool, released } = fakePool(async () => undefined);
  await assert.rejects(
    withPgTransaction(pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(released, [undefined]);
});

test("a migration whose ROLLBACK fails keeps its error and discards the connection", async () => {
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql === "SELECT broken_migration") throw new Error("migration failed");
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: sql.includes("pg_try_advisory_lock") ? [{ locked: true }] : [], rowCount: 0 };
    },
    release: (value?: unknown) => {
      released.push(value);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    applyPgMigrations(pool, [definePgMigration("test/rollback/0001", ["SELECT broken_migration"])]),
    /migration failed/,
  );
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error);
  assert.equal((released[0] as Error).message, "connection lost");
});
