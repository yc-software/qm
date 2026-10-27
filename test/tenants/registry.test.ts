import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { configurePgTenancy, createPgPool } from "../../src/persistence/pg-pool.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";
import {
  assertRowSecurityEnforced,
  homeTenantId,
  listTenants,
  upsertTenant,
  type TenantRecord,
} from "../../src/tenants/registry.ts";

const URL = process.env.DATABASE_URL!;

// RLS does not apply to superusers, so the test provisions a plain login and a database it owns.
async function provision(): Promise<{ url: string; drop: () => Promise<void> }> {
  const pg = (await import("pg")).default;
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  const suffix = randomBytes(4).toString("hex");
  const role = `qm_tenancy_${suffix}`;
  const db = `qm_tenancy_${suffix}`;
  const password = randomBytes(12).toString("hex");
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${role}`);
  await admin.end();
  const parsed = new globalThis.URL(URL);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${db}`;
  return {
    url: parsed.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${role}`);
      await c.end();
    },
  };
}

test("tenancy: tenant_id leads every key, RLS separates tenants, legacy rows stay with the home tenant", async () => {
  const { url, drop } = await provision();
  configurePgTenancy(true);
  try {
    const legacy = createPgPool(url, [
      {
        id: "tenancy-test/0001",
        statements: [
          `CREATE TABLE widgets(id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT)`,
          `CREATE UNIQUE INDEX widgets_email ON widgets(lower(email)) WHERE email IS NOT NULL`,
          `CREATE TABLE parts(id BIGSERIAL PRIMARY KEY, widget_id TEXT REFERENCES widgets(id) ON DELETE CASCADE,
             owner_id TEXT REFERENCES widgets(id) ON DELETE SET NULL, name TEXT NOT NULL, UNIQUE(widget_id, name))`,
          `CREATE TABLE counters(only_row BOOLEAN PRIMARY KEY DEFAULT TRUE, v BIGINT NOT NULL)`,
          `CREATE OR REPLACE FUNCTION bump_counter() RETURNS trigger LANGUAGE plpgsql AS $fn$
           BEGIN
             INSERT INTO counters(only_row, v) VALUES (TRUE, 1) ON CONFLICT (only_row) DO UPDATE SET v = counters.v + 1;
             RETURN NULL;
           END $fn$`,
          `CREATE TRIGGER widgets_bump AFTER INSERT ON widgets FOR EACH STATEMENT EXECUTE FUNCTION bump_counter()`,
          `INSERT INTO widgets(id, label, email) VALUES ('w1', 'legacy', 'A@x.com')`,
        ],
      },
    ]);
    await legacy.pool();
    await assertRowSecurityEnforced(legacy);
    const home = await homeTenantId(legacy);
    const cols = await legacy.q(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'parts'::regclass ORDER BY conname`,
    );
    for (const c of cols) assert.match(String(c.def), /tenant_id/, `${String(c.conname)} leads with tenant_id`);
    assert.deepEqual(await legacy.q(`SELECT id, tenant_id::text AS t FROM widgets`), [{ id: "w1", t: home }]);

    const a = tenantFor("org-a", randomUUID(), "a");
    const b = tenantFor("org-b", randomUUID(), "b");
    for (const t of [a, b]) {
      await withTenant(t, async () => {
        await legacy.query(
          `INSERT INTO widgets(id, label, email) VALUES ('w1', $1, 'a@X.com')
           ON CONFLICT (tenant_id, id) DO UPDATE SET label = EXCLUDED.label`,
          [t.slug],
        );
        await legacy.query(`INSERT INTO parts(widget_id, owner_id, name) VALUES ('w1', 'w1', 'p')`);
      });
    }
    await withTenant(a, async () => {
      assert.deepEqual(await legacy.q(`SELECT id, label FROM widgets`), [{ id: "w1", label: "a" }]);
      assert.equal((await legacy.q(`SELECT count(*)::int AS n FROM parts`))[0]!.n, 1);
      assert.equal((await legacy.q(`SELECT v::int AS v FROM counters`))[0]!.v, 1);
      await legacy.query(`DELETE FROM widgets WHERE id = 'w1'`);
      assert.equal((await legacy.q(`SELECT count(*)::int AS n FROM parts`))[0]!.n, 0);
    });
    await withTenant(b, async () => {
      assert.deepEqual(await legacy.q(`SELECT id, label FROM widgets`), [{ id: "w1", label: "b" }]);
      assert.equal((await legacy.q(`SELECT count(*)::int AS n FROM parts`))[0]!.n, 1);
      await assert.rejects(
        legacy.query(`INSERT INTO widgets(tenant_id, id, label) VALUES ($1, 'w9', 'forged')`, [a.id]),
        /row-level security/,
      );
    });
    assert.deepEqual(await legacy.q(`SELECT id, label FROM widgets`), [{ id: "w1", label: "legacy" }]);

    await upsertTenant(
      legacy,
      {
        id: a.id!,
        slug: "a",
        orgId: "org-a",
        hosts: ["a.example.com"],
        status: "active",
        s3Bucket: "bucket-a",
        oidcAdmin: false,
        secrets: { slackServiceToken: "slack-a" },
      } satisfies TenantRecord,
      randomBytes(32),
    ).catch((error: unknown) => assert.fail(String(error)));
    await assert.rejects(listTenants(legacy, undefined), /QM_TENANT_SECRETS_KEY/);
    await legacy.close();
  } finally {
    configurePgTenancy(false);
    await drop();
  }
});
