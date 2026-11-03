import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DIRECTORY_MIGRATIONS } from "../src/directory/postgres-directory-store.ts";
import { applyPgMigrations, createPgPool, definePgMigration, withPgTransaction } from "../src/persistence/pg-pool.ts";
import { SESSION_MIGRATIONS } from "../src/sessions/session-schema.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { TENANCY_BASE } from "../src/tenants/migrations.ts";
import { testDatabaseUrl, testMigratedDatabaseUrl } from "./support/test-database.ts";

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

before(async () => {
  if (skip) return;
  url = testMigratedDatabaseUrl();
  owner = new pg.Pool({ connectionString: url });
  app = new pg.Pool({ connectionString: asRole(url, "qm_app") });
  await owner.query("INSERT INTO tenants(id, slug, name) VALUES ($1, 'tenant-a', 'A'), ($2, 'tenant-b', 'B')", [a, b]);
  await owner.query(
    `CREATE TABLE tenant_probe(tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id), n int)`,
  );
  await owner.query("ALTER TABLE tenant_probe ENABLE ROW LEVEL SECURITY");
  await owner.query(`CREATE POLICY tenant_app ON tenant_probe FOR ALL TO qm_app
    USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`);
  await owner.query("INSERT INTO tenant_probe(tenant_id, n) VALUES ($1, 1), ($2, 2)", [a, b]);
});

after(async () => {
  await owner?.end();
  await app?.end();
});

test("qm_bound_tenant raises when no tenant is bound and returns the bound one", { skip }, async () => {
  await assert.rejects(owner.query("SELECT qm_bound_tenant()"), { code: "42501", message: /No tenant is bound/ });
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('qm.tenant_id', $1, true)", [a]);
    assert.equal((await client.query("SELECT qm_bound_tenant()::text AS t")).rows[0].t, a);
    await client.query("COMMIT");
    await assert.rejects(client.query("SELECT qm_bound_tenant()"), { code: "42501" });
  } finally {
    client.release();
  }
});

test("the tenant logins cannot bypass row security or change tenants", { skip }, async () => {
  const roles = await owner.query(
    "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('qm_app', 'qm_reader') ORDER BY rolname",
  );
  assert.deepEqual(roles.rows, [
    { rolname: "qm_app", rolcanlogin: true, rolsuper: false, rolbypassrls: false },
    { rolname: "qm_reader", rolcanlogin: true, rolsuper: false, rolbypassrls: false },
  ]);
  const reader = new pg.Pool({ connectionString: asRole(url, "qm_reader") });
  try {
    for (const pool of [app, reader]) {
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM tenants WHERE id = $1", [a])).rows[0].n, 1);
      await assert.rejects(pool.query("DELETE FROM tenants"), { code: "42501" });
    }
    await assert.rejects(reader.query("INSERT INTO sessions(id) VALUES ('x')"), { code: "42501" });
    await assert.rejects(app.query(TENANCY_BASE.statements[0]!), { code: "42501", message: /database owner/ });
  } finally {
    await reader.end();
  }
});

test("the pool binds the current tenant to each query and transaction in one batch", { skip }, async () => {
  const pool = createPgPool(asRole(url, "qm_app"));
  try {
    const setting =
      "SELECT current_setting('qm.tenant_id', true) AS t, current_setting('statement_timeout') AS timeout";
    const seen = await Promise.all([a, b, a, b].map((id) => withTenant(id, async () => (await pool.q(setting))[0]!.t)));
    assert.deepEqual(seen, [a, b, a, b]);
    const probe = await withTenant(b, () => pool.q("SELECT n FROM tenant_probe", [], { timeoutMs: 5_000 }));
    assert.deepEqual(probe, [{ n: 2 }]);
    const both = await withTenant(a, () => pool.q(setting, [], { timeoutMs: 4_000 }));
    assert.deepEqual(both, [{ t: a, timeout: "4s" }]);
    const signalled = await withTenant(a, () => pool.q(setting, [], { signal: new AbortController().signal }));
    assert.equal(signalled[0]!.t, a);
    const inTx = await withTenant(b, async () =>
      withPgTransaction(await pool.pool(), async (client) => {
        await client.query("INSERT INTO tenant_probe(n) VALUES (3)");
        return (await client.query("SELECT tenant_id::text AS t FROM tenant_probe WHERE n = 3")).rows[0].t;
      }),
    );
    assert.equal(inTx, b);
    await withoutTenant(async () => {
      for (let i = 0; i < 8; i++) assert.ok([null, ""].includes((await pool.q(setting))[0]!.t as string | null));
      await assert.rejects(pool.q("SELECT n FROM tenant_probe"), { code: "42501" });
      await assert.rejects(pool.q("INSERT INTO tenant_probe(n) VALUES (4)"), { code: "42501" });
    });
  } finally {
    await pool.close();
  }
});

test("a bound tenant cannot see or write another tenant's rows", { skip }, async () => {
  const pool = createPgPool(asRole(url, "qm_app"));
  try {
    await withTenant(a, async () => {
      assert.deepEqual(await pool.q("SELECT n FROM tenant_probe"), [{ n: 1 }]);
      assert.equal((await pool.query("UPDATE tenant_probe SET n = 9 WHERE tenant_id = $1", [b])).rowCount, 0);
      assert.equal((await pool.query("DELETE FROM tenant_probe WHERE tenant_id = $1", [b])).rowCount, 0);
      await assert.rejects(pool.q("INSERT INTO tenant_probe(tenant_id, n) VALUES ($1, 5)", [b]), { code: "42501" });
    });
    const rows = await owner.query("SELECT n FROM tenant_probe WHERE tenant_id = $1 ORDER BY n", [b]);
    assert.deepEqual(rows.rows, [{ n: 2 }, { n: 3 }]);
  } finally {
    await pool.close();
  }
});

test("the tenancy migration fails when the host refuses a grant", { skip }, async () => {
  const bare = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
  const role = `qm_migrator_${randomUUID().replaceAll("-", "")}`;
  try {
    await bare.query("CREATE TABLE owned_elsewhere(id int)");
    await bare.query(`CREATE ROLE ${role} CREATEROLE`);
    await bare.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${role}`);
    await bare.query(`SET ROLE ${role}`);
    await assert.rejects(applyPgMigrations(bare, [definePgMigration(TENANCY_BASE)]), {
      code: "42501",
      message: /owned_elsewhere/,
    });
    await bare.query("RESET ROLE");
    assert.equal((await bare.query("SELECT to_regclass('tenants') AS t")).rows[0].t, null);
  } finally {
    await bare.query("RESET ROLE").catch(() => undefined);
    await bare.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await bare.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await bare.end();
  }
});

test("upgrading keeps the previous release's tenant objects and its migrations still apply", { skip }, async () => {
  const previous = [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS.filter((m) => m !== TENANCY_BASE)].map(
    definePgMigration,
  );
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
  try {
    await applyPgMigrations(pool, previous);
    const old = (await pool.query("SELECT qm_tenant_id()::text AS id")).rows[0].id;
    await applyPgMigrations(pool, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS].map(definePgMigration));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
    await applyPgMigrations(pool, previous);
    assert.equal((await pool.query("SELECT qm_tenant_id()::text AS id")).rows[0].id, old);
  } finally {
    await pool.end();
  }
});
