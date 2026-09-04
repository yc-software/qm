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
    return { rows: [{ token: "t", json: { n: 1 } }], rowCount: 1 };
  }
  return {
    pool: () => Promise.reject(new Error("not backed by a real pool")),
    query,
    q: async (text, params) => (await query(text, params ?? [])).rows,
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
  const pg = createPgPool("postgres://127.0.0.1:9/nope", ["SELECT 1"]);
  const first = await pg.q("SELECT 1").catch((e: unknown) => e);
  const second = await pg.q("SELECT 1").catch((e: unknown) => e);
  assert.ok(first instanceof Error);
  assert.ok(second instanceof Error);
  assert.notEqual(first, second, "each call gets a fresh attempt, not the same cached rejection");
  await pg.close();
});

test("pg pool: an idle-client 'error' is logged, not fatal", { skip }, async () => {
  const pg = createPgPool(URL!, ["SELECT 1"]);
  const pool = await pg.pool();
  assert.doesNotThrow(() => pool.emit("error", new Error("backend died")));
  assert.deepEqual((await pg.query("SELECT 1 AS one")).rows, [{ one: 1 }], "pool keeps serving queries");
  await pg.close();
});

test("pg pool: concurrent index creation recovers an invalid prior attempt", { skip }, async () => {
  const pg = createPgPool(URL!, ["DROP TABLE IF EXISTS qm_concurrent_index_retry CASCADE"]);
  try {
    await pg.schema!("CREATE TABLE qm_concurrent_index_retry(value INT NOT NULL)");
    await pg.query("INSERT INTO qm_concurrent_index_retry(value) VALUES (1), (1)");
    await assert.rejects(
      pg.schema!("CREATE UNIQUE INDEX CONCURRENTLY qm_concurrent_index_retry_idx ON qm_concurrent_index_retry(value)"),
      /could not create unique index/,
    );
    await pg.schema!(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS qm_concurrent_index_retry_idx ON qm_concurrent_index_retry(value)",
    );
    assert.deepEqual(
      await pg.q(
        "SELECT indisvalid, indisready FROM pg_index WHERE indexrelid = to_regclass('qm_concurrent_index_retry_idx')",
      ),
      [{ indisvalid: true, indisready: true }],
    );
  } finally {
    await pg.query("DROP TABLE IF EXISTS qm_concurrent_index_retry CASCADE");
    await pg.close();
  }
});
