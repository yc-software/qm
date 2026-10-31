import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { DIRECTORY_MIGRATIONS } from "../src/directory/postgres-directory-store.ts";
import { applyPgMigrations, createPgPool, definePgMigration, withPgTransaction } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { SESSION_SCHEMA } from "../src/sessions/session-schema.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { TENANCY_BASE } from "../src/tenants/migrations.ts";
import { scopeId } from "../src/types.ts";
import { testBareDatabaseUrl, testMigratedDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";
const [a, b] = process.env.DATABASE_URL ? testTenants() : ["", ""];

function asRole(databaseUrl: string, role: "qm_app" | "qm_reader"): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

async function inTenant<T>(pool: pg.Pool, tenant: string | null, fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenant) await client.query("SELECT set_config('qm.tenant_id', $1, true)", [tenant]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

let url = "";
let owner: pg.Pool;
let app: pg.Pool;
let sessionId = "";

const insertItem = (seq: number) =>
  `INSERT INTO items(session_id, seq, kind, body, created_at) VALUES ($1, ${seq}, 'UserMessage', '{}', now())`;
const insertItemFor = (seq: number) =>
  `INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at) VALUES ($2, $1, ${seq}, 'UserMessage', '{}', now())`;

before(async () => {
  if (skip) return;
  url = testMigratedDatabaseUrl();
  owner = new pg.Pool({ connectionString: url });
  app = new pg.Pool({ connectionString: asRole(url, "qm_app") });
  const store = createPostgresSessionStore(url);
  sessionId = (await store.getOrCreateByThread(`tenancy-${randomUUID()}`, "dm", scopeId("personal", "t"))).id;
  await owner.query(insertItemFor(0), [sessionId, a]);
  await owner.query(insertItemFor(1), [sessionId, b]);
});

after(async () => {
  await owner?.end();
  await app?.end();
});

test("a bound tenant reads only its own items under qm_app", { skip }, async () => {
  const rows = await inTenant(app, a, (c) =>
    c.query("SELECT tenant_id::text, seq FROM items WHERE session_id = $1", [sessionId]),
  );
  assert.deepEqual(rows.rows, [{ tenant_id: a, seq: "0" }]);
  const all = await owner.query("SELECT count(*)::int AS n FROM items WHERE session_id = $1", [sessionId]);
  assert.equal(all.rows[0].n, 2);
});

test("a bound tenant cannot update, delete or insert another tenant's items", { skip }, async () => {
  await inTenant(app, a, async (c) => {
    const updated = await c.query("UPDATE items SET body = '{\"x\":1}' WHERE tenant_id = $1", [b]);
    assert.equal(updated.rowCount, 0);
    const deleted = await c.query("DELETE FROM items WHERE tenant_id = $1", [b]);
    assert.equal(deleted.rowCount, 0);
    await assert.rejects(c.query(insertItemFor(2), [sessionId, b]), { code: "42501" });
  });
  await inTenant(app, a, async (c) => {
    await c.query(insertItem(3), [sessionId]);
    const own = await c.query("SELECT tenant_id::text FROM items WHERE session_id = $1 AND seq = 3", [sessionId]);
    assert.deepEqual(own.rows, [{ tenant_id: a }]);
  });
  const bRows = await owner.query("SELECT seq FROM items WHERE tenant_id = $1 AND session_id = $2", [b, sessionId]);
  assert.deepEqual(bRows.rows, [{ seq: "1" }]);
});

test("an unbound query raises instead of seeing every tenant", { skip }, async () => {
  for (const pool of [app, owner]) {
    await assert.rejects(
      inTenant(pool, null, (c) => c.query("SELECT count(*) FROM items WHERE tenant_id = qm_bound_tenant()")),
      { code: "42501", message: /No tenant is bound/ },
    );
  }
  await assert.rejects(
    inTenant(app, null, (c) => c.query("SELECT count(*) FROM items")),
    { code: "42501" },
  );
  await assert.rejects(
    inTenant(app, null, (c) => c.query(insertItem(4), [sessionId])),
    { code: "42501" },
  );
});

test("qm_reader reads its bound tenant and cannot write", { skip }, async () => {
  const reader = new pg.Pool({ connectionString: asRole(url, "qm_reader") });
  try {
    const rows = await inTenant(reader, b, (c) => c.query("SELECT seq FROM items WHERE session_id = $1", [sessionId]));
    assert.deepEqual(rows.rows, [{ seq: "1" }]);
    await assert.rejects(
      inTenant(reader, b, (c) => c.query(insertItem(5), [sessionId])),
      { code: "42501" },
    );
    const tenants = await inTenant(reader, null, (c) => c.query("SELECT count(*)::int AS n FROM tenants"));
    assert.equal(tenants.rows[0].n, 2);
  } finally {
    await reader.end();
  }
});

test("tenant_id must name a tenant row", { skip }, async () => {
  await assert.rejects(owner.query(insertItemFor(6), [sessionId, randomUUID()]), { code: "23503" });
  await assert.rejects(
    owner.query("INSERT INTO blobs(tenant_id, sha256, size, storage_key) VALUES ($1, $2, 1, 'k')", [
      randomUUID(),
      randomBytes(32),
    ]),
    { code: "23503" },
  );
});

test("qm_app can read tenants but not change them, and cannot run the tenancy migration", { skip }, async () => {
  const tenants = await inTenant(app, null, (c) => c.query("SELECT id::text FROM tenants ORDER BY id"));
  assert.deepEqual(
    tenants.rows.map((row) => row.id),
    [a, b].sort(),
  );
  await assert.rejects(
    inTenant(app, null, (c) => c.query("DELETE FROM tenants")),
    { code: "42501" },
  );
  await assert.rejects(
    inTenant(app, null, (c) => c.query(TENANCY_BASE.statements[0]!)),
    {
      code: "42501",
      message: /database owner/,
    },
  );
});

test("the pool binds the current tenant to each query and transaction", { skip }, async () => {
  const pool = createPgPool(asRole(url, "qm_app"));
  try {
    const setting = "SELECT current_setting('qm.tenant_id', true) AS t";
    const seen = await Promise.all([a, b, a, b].map((id) => withTenant(id, async () => (await pool.q(setting))[0]!.t)));
    assert.deepEqual(seen, [a, b, a, b]);
    await withoutTenant(async () => {
      for (let i = 0; i < 12; i++) assert.ok([null, ""].includes((await pool.q(setting))[0]!.t as string | null));
      await assert.rejects(pool.q("SELECT count(*) FROM items"), { code: "42501" });
    });
    const counted = await withTenant(b, () =>
      pool.q("SELECT count(*)::int AS n FROM items WHERE session_id = $1", [sessionId], { timeoutMs: 5_000 }),
    );
    assert.equal(counted[0]!.n, 1);
    const signal = new AbortController().signal;
    const signalled = await withTenant(a, () => pool.q(setting, [], { signal }));
    assert.equal(signalled[0]!.t, a);
    const inTx = await withTenant(b, async () =>
      withPgTransaction(await pool.pool(), async (client) => (await client.query(setting)).rows[0].t),
    );
    assert.equal(inTx, b);
  } finally {
    await pool.close();
  }
});

async function legacyDatabase(seed: (pool: pg.Pool) => Promise<void>): Promise<pg.Pool> {
  const legacyUrl = testBareDatabaseUrl();
  const pool = new pg.Pool({ connectionString: legacyUrl, max: 1 });
  await applyPgMigrations(pool, [...DIRECTORY_MIGRATIONS, SESSION_SCHEMA].map(definePgMigration));
  await seed(pool);
  const store = createPostgresSessionStore(legacyUrl);
  await withoutTenant(() => store.scanAll());
  return pool;
}

const legacyGone = async (pool: pg.Pool) => {
  const rows = await pool.query(
    "SELECT to_regclass('qm_tenant') AS t, to_regprocedure('qm_tenant_id()') AS f, to_regprocedure('qm_bound_tenant()') AS b",
  );
  assert.deepEqual(rows.rows, [{ t: null, f: null, b: "qm_bound_tenant()" }]);
};

test("upgrading a database with items gives their owner a tenant with the old id", { skip }, async () => {
  let old = "";
  const pool = await legacyDatabase(async (p) => {
    old = (await p.query("SELECT qm_tenant_id()::text AS id")).rows[0].id;
    await p.query(
      "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ('s1', 'dm', 'personal:x', 's1', 0)",
    );
    await p.query(
      "INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at) VALUES (qm_tenant_id(), 's1', 0, 'UserMessage', '{}', now())",
    );
  });
  try {
    const tenants = await pool.query("SELECT id::text, slug, name FROM tenants");
    assert.deepEqual(tenants.rows, [{ id: old, slug: old, name: old }]);
    const items = await pool.query("SELECT tenant_id::text FROM items");
    assert.deepEqual(items.rows, [{ tenant_id: old }]);
    await legacyGone(pool);
  } finally {
    await pool.end();
  }
});

test("upgrading a database with only blobs gives their owner a tenant too", { skip }, async () => {
  let old = "";
  const pool = await legacyDatabase(async (p) => {
    old = (await p.query("SELECT qm_tenant_id()::text AS id")).rows[0].id;
    await p.query("INSERT INTO blobs(tenant_id, sha256, size, storage_key) VALUES (qm_tenant_id(), $1, 1, 'k')", [
      randomBytes(32),
    ]);
  });
  try {
    const tenants = await pool.query("SELECT id::text FROM tenants");
    assert.deepEqual(tenants.rows, [{ id: old }]);
    await legacyGone(pool);
  } finally {
    await pool.end();
  }
});

test("upgrading an empty database creates no tenant", { skip }, async () => {
  const pool = await legacyDatabase(async () => undefined);
  try {
    const tenants = await pool.query("SELECT count(*)::int AS n FROM tenants");
    assert.equal(tenants.rows[0].n, 0);
    await legacyGone(pool);
  } finally {
    await pool.end();
  }
});
