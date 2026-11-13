import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DIRECTORY_MIGRATIONS } from "../src/directory/postgres-directory-store.ts";
import {
  applyPgMigrations,
  createPgPool,
  definePgMigration,
  type PgMigrationDefinition,
  withPgTransaction,
} from "../src/persistence/pg-pool.ts";
import { DROP_SESSION_LEASES, SESSION_MIGRATIONS, TENANT_BACKFILL } from "../src/sessions/session-schema.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { TENANCY } from "../src/tenants/migrations.ts";
import { testBareDatabaseUrl, testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";

function asRole(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

let url = "";
let owner: pg.Pool;
let app: pg.Pool;
const a = randomUUID();
const b = randomUUID();
const role = `tenant_probe_${randomUUID().slice(0, 8)}`;

before(async () => {
  if (skip) return;
  url = ownerUrl(testMigratedDatabaseUrl()).toString();
  owner = new pg.Pool({ connectionString: url });
  await owner.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
  app = new pg.Pool({ connectionString: asRole(url, role) });
  await owner.query("INSERT INTO tenants(id) VALUES ($1), ($2)", [a, b]);
  await owner.query(
    `CREATE TABLE tenant_probe(tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id), n int)`,
  );
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_probe TO ${role}`);
  await owner.query("ALTER TABLE tenant_probe ENABLE ROW LEVEL SECURITY");
  await owner.query(`CREATE POLICY tenant_app ON tenant_probe FOR ALL TO ${role}
    USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`);
  await owner.query("INSERT INTO tenant_probe(tenant_id, n) VALUES ($1, 1), ($2, 2)", [a, b]);
});

after(async () => {
  await app?.end();
  await owner?.query(`DROP OWNED BY ${role}`);
  await owner?.query(`DROP ROLE IF EXISTS ${role}`);
  await owner?.end();
});

test("qm_bound_tenant raises when no tenant is bound and returns the bound one", { skip }, async () => {
  await assert.rejects(owner.query("SELECT qm_bound_tenant()"), { code: "42501", message: /No tenant is bound/ });
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('qm.tenant_id', $1, true)", [a]);
    assert.equal((await client.query("SELECT qm_bound_tenant()::text AS t")).rows[0].t, a);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

test("the pool binds the current tenant to each query and transaction in one batch", { skip }, async () => {
  const pool = createPgPool(asRole(url, role));
  try {
    const setting = "SELECT current_setting('qm.tenant_id', true) AS t";
    const probe = await withTenant(b, () =>
      pool.q("SELECT n, current_setting('statement_timeout') AS timeout FROM tenant_probe", [], { timeoutMs: 5_000 }),
    );
    assert.deepEqual(probe, [{ n: 2, timeout: "5s" }]);
    const seen = await Promise.all([a, b, a, b].map((id) => withTenant(id, async () => (await pool.q(setting))[0]!.t)));
    assert.deepEqual(seen, [a, b, a, b]);
    const inTx = await withTenant(b, async () =>
      withPgTransaction(await pool.pool(), async (client) => {
        await client.query("INSERT INTO tenant_probe(n) VALUES (3)");
        return (await client.query("SELECT tenant_id::text AS t FROM tenant_probe WHERE n = 3")).rows[0].t;
      }),
    );
    assert.equal(inTx, b);
    const unpipelined = await withTenant(a, () =>
      withPgTransaction(app, async (client) => (await client.query(setting)).rows[0].t),
    );
    assert.equal(unpipelined, a);
    await withTenant(a, async () => {
      await pool.q("INSERT INTO tenant_probe(n) VALUES (6)", [], { signal: new AbortController().signal });
      assert.equal((await pool.query("UPDATE tenant_probe SET n = 9 WHERE tenant_id = $1", [b])).rowCount, 0);
      assert.equal((await pool.query("DELETE FROM tenant_probe WHERE tenant_id = $1", [b])).rowCount, 0);
      await assert.rejects(pool.q("INSERT INTO tenant_probe(tenant_id, n) VALUES ($1, 5)", [b]), { code: "42501" });
    });
    await withoutTenant(async () => {
      await assert.rejects(pool.q("SELECT n FROM tenant_probe"), { code: "42501" });
      await assert.rejects(pool.q("INSERT INTO tenant_probe(n) VALUES (4)"), { code: "42501" });
    });
    const rows = await owner.query("SELECT tenant_id::text AS t, n FROM tenant_probe ORDER BY n");
    assert.deepEqual(rows.rows, [
      { t: a, n: 1 },
      { t: b, n: 2 },
      { t: b, n: 3 },
      { t: a, n: 6 },
    ]);
  } finally {
    await pool.close();
  }
});

test("an open transaction refuses work for a different tenant until it has ended", { skip }, async () => {
  await withTenant(a, () =>
    withPgTransaction(app, async (client) => {
      assert.throws(() => withTenant(b, () => 0), /already open for another tenant/);
      assert.throws(() => withoutTenant(() => 0), /already open for another tenant/);
      assert.equal(
        withTenant(a, () => 1),
        1,
      );
      return client.query("SELECT 1");
    }),
  );
  await withoutTenant(() =>
    withPgTransaction(app, async () => assert.throws(() => withTenant(a, () => 0), /already open/)),
  );
  const outcomes: string[] = [];
  let settled = false;
  let spawned: Promise<string[]> | undefined;
  const watch = (resolve: (seen: string[]) => void) => {
    try {
      withTenant(b, () => outcomes.push("bound"));
    } catch {
      outcomes.push("refused");
    }
    if (settled) resolve(outcomes);
    else setImmediate(watch, resolve);
  };
  await assert.rejects(
    withTenant(a, () =>
      withPgTransaction(app, async () => {
        spawned = new Promise(watch);
        throw new Error("body failed");
      }),
    ),
    /body failed/,
  );
  settled = true;
  const seen = await spawned!;
  assert.equal(seen.pop(), "bound");
  assert.deepEqual(new Set(seen), new Set(["refused"]));
});

const preTenancy = (m: PgMigrationDefinition) =>
  !TENANCY.includes(m) && m !== TENANT_BACKFILL && m !== DROP_SESSION_LEASES && !/-tenant|claim/.test(m.id);

test("upgrading copies the existing tenant into tenants", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: testBareDatabaseUrl(), max: 1 });
  try {
    const previous = SESSION_MIGRATIONS.filter(preTenancy);
    await applyPgMigrations(pool, [...DIRECTORY_MIGRATIONS, ...previous].map(definePgMigration));
    const old = (await pool.query("SELECT qm_tenant_id()::text AS id")).rows[0].id;
    await pool.query(
      "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ('s', 'dm', 'personal:u', 's', 0)",
    );
    await applyPgMigrations(pool, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS].map(definePgMigration));
    assert.ok((await pool.query("SELECT id::text FROM tenants")).rows.some((row) => row.id === old));
  } finally {
    await pool.end();
  }
});

test("upgrading keeps every table on the existing tenant when another store migrates first", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: testBareDatabaseUrl(), max: 1 });
  try {
    await applyPgMigrations(
      pool,
      [...DIRECTORY_MIGRATIONS.filter(preTenancy), ...SESSION_MIGRATIONS.filter(preTenancy)].map(definePgMigration),
    );
    const old = (await pool.query("SELECT qm_tenant_id()::text AS id")).rows[0].id;
    await pool.query("INSERT INTO directory_meta(org_id, updated_at) VALUES ('org', 0)");
    await pool.query(
      "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ('s', 'dm', 'personal:u', 's', 0)",
    );
    await pool.query(
      `INSERT INTO items(tenant_id, session_id, seq, kind, text, body, created_at)
       VALUES ($1, 's', 0, 'UserMessage', 'hi', '{}', now())`,
      [old],
    );
    const all = [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS].toSorted((x, y) => x.id.localeCompare(y.id));
    await applyPgMigrations(pool, [...new Map(all.map((m) => [m.id, m])).values()].map(definePgMigration));
    assert.deepEqual((await pool.query("SELECT id::text FROM tenants")).rows, [{ id: old }]);
    for (const table of ["directory_meta", "sessions", "items"]) {
      const { rows } = await pool.query(`SELECT DISTINCT tenant_id::text AS id FROM ${table}`);
      assert.deepEqual(rows, [{ id: old }], table);
    }
  } finally {
    await pool.end();
  }
});

test("migrating an empty database mints no tenant", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: testBareDatabaseUrl(), max: 1 });
  try {
    await applyPgMigrations(pool, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS].map(definePgMigration));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
    await pool.query("SET ROLE qm_app");
    assert.equal((await pool.query("SELECT qm_boot_tenant() AS id")).rows[0].id, null);
    assert.deepEqual((await pool.query("SELECT * FROM qm_serving_tenants()")).rows, []);
  } finally {
    await pool.end();
  }
});
