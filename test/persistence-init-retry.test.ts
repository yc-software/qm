import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgListener, createPgPool, type PgPool, type Rows } from "../src/persistence/pg-pool.ts";
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
    connect: () => Promise.reject(new Error("not backed by a real pool")),
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

test("pg pool: the next checkout recovers after an idle backend is terminated", { skip }, async () => {
  const pg = createPgPool(URL!, []);
  const killer = createPgPool(URL!, []);
  try {
    const idle = await pg.connect();
    const result = await idle.query("SELECT pg_backend_pid() AS pid");
    const pid = Number(result.rows[0]!.pid);
    idle.release();
    const killed = await killer.q("SELECT pg_terminate_backend($1) AS killed", [pid]);
    assert.equal(killed[0]?.killed, true);
    assert.deepEqual((await pg.query("SELECT 1 AS one")).rows, [{ one: 1 }]);
  } finally {
    await pg.close();
    await killer.close();
  }
});

test("pg listener: a terminated LISTEN backend reconnects and receives later notifications", { skip }, async () => {
  const pg = createPgPool(URL!, []);
  const sender = createPgPool(URL!, []);
  const channel = `listener_recovery_${process.pid}`;
  let notifications = 0;
  let reconnects = 0;
  const listener = createPgListener(
    pg,
    channel,
    () => notifications++,
    () => reconnects++,
  );
  try {
    for (let i = 0; i < 100; i++) {
      const rows = await sender.q("SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query = $1", [
        `LISTEN ${channel}`,
      ]);
      if (rows.length > 0) {
        await sender.q("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (i === 99) assert.fail("listener did not establish");
    }
    for (let i = 0; i < 150 && reconnects === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reconnects, 1);
    await sender.q(`SELECT pg_notify('${channel}', 'ready')`);
    for (let i = 0; i < 100 && notifications === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notifications, 1);
  } finally {
    listener.close();
    await pg.close();
    await sender.close();
  }
});
