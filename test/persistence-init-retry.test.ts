import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, type PgPool, type Rows } from "../src/persistence/pg-pool.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the live-pool tests";

function flakyPgPool(failures: number): PgPool {
  let remaining = failures;
  async function query(_text: string, _params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    if (remaining > 0) {
      remaining--;
      throw new Error("transient pg failure");
    }
    return {
      rows: [{ token: "t", json: { n: 1 } }],
      rowCount: 1,
    };
  }
  return {
    sessionPool: () => Promise.reject(new Error("not backed by a real pool")),
    pool: () => Promise.reject(new Error("not backed by a real pool")),
    query,
    q: async (text, params) => (await query(text, params ?? [])).rows,
    registerMigration: () => {},
    migrate: async () => {},
    close: async () => {},
  };
}

test("pg map: a failed table-create is retried on the next call (rejection not cached)", async () => {
  const m = createPostgresMap<{ n: number }>(flakyPgPool(1), "retry_widgets");
  await assert.rejects(() => m.all(), /transient pg failure/);
  assert.deepEqual(await m.all(), [{ n: 1 }], "second call re-runs the table create and proceeds to the query");
});

test("admin grants: a failed seed is retried on the next call (rejection not cached)", async () => {
  let failures = 1;
  const rows: AdminGrant[] = [];
  const persist: AdminGrantPersistence = {
    async all() {
      if (failures > 0) {
        failures--;
        throw new Error("transient pg failure");
      }
      return [...rows];
    },
    async put(g) {
      rows.push(g);
    },
    async remove() {},
  };
  const store = createAdminGrantStore(persist, {
    seed: [{ principalId: "p", scopeId: scopeId("personal", "p"), role: "org_admin" }],
  });
  await assert.rejects(() => store.list(), /transient pg failure/);
  const listed = await store.list();
  assert.equal(listed.length, 1, "second call re-runs seeding and lists the seeded grant");
});

test("pg pool: a failed init is retried with a fresh attempt (rejection not cached)", async () => {
  const pg = createPgPool("postgres://127.0.0.1:9/nope", "test/retry/unreachable/0001", ["SELECT 1"]);
  const first = await pg.q("SELECT 1").catch((e: unknown) => e);
  const second = await pg.q("SELECT 1").catch((e: unknown) => e);
  assert.ok(first instanceof Error);
  assert.ok(second instanceof Error);
  assert.notEqual(first, second, "each call gets a fresh attempt, not the same cached rejection");
  await pg.close();
});

test("pg pool: an idle-client 'error' is logged, not fatal", { skip }, async () => {
  const pg = createPgPool(URL!, "test/retry/live/0001", ["SELECT 1"]);
  const pool = await pg.pool();
  assert.doesNotThrow(() => pool.emit("error", new Error("backend died")));
  assert.deepEqual((await pg.query("SELECT 1 AS one")).rows, [{ one: 1 }], "pool keeps serving queries");
  await pg.close();
});

test("pg pool: a timeoutMs query gives the connection back usable, not poisoned", { skip }, async () => {
  const pg = createPgPool(URL!, "test/retry/timeout/0001", ["SELECT 1"]);
  await assert.rejects(
    () => pg.q("SELECT pg_sleep(5)", [], { timeoutMs: 150 }),
    /statement timeout/i,
    "a query past its budget is cancelled by Postgres instead of hanging",
  );
  assert.deepEqual(await pg.q("SELECT 1 AS one"), [{ one: 1 }], "the pool keeps serving after a timeout");
  assert.deepEqual(
    await pg.q("SELECT 2 AS two", [], { timeoutMs: 5_000 }),
    [{ two: 2 }],
    "a query inside its budget returns normally",
  );
  const [row] = await pg.q("SHOW statement_timeout");
  assert.equal(row!.statement_timeout, "0", "the budget does not leak onto the next borrower of the connection");
  await pg.close();
});
