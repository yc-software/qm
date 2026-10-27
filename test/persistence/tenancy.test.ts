import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { configurePgTenancy } from "../../src/persistence/pg-pool.ts";
import { applyTenancy, TENANT_BYPASS_OPTION } from "../../src/persistence/tenancy.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { tenantFor, withTenant, type Tenant } from "../../src/tenant.ts";
import { scopeId } from "../../src/types.ts";

const URL = process.env.DATABASE_URL!;

// RLS does not apply to superusers, so the test provisions a plain login and a database it owns.
async function provision(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  const suffix = randomBytes(4).toString("hex");
  const role = `qm_attrib_${suffix}`;
  const password = randomBytes(12).toString("hex");
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${role} OWNER ${role}`);
  await admin.end();
  const parsed = new globalThis.URL(URL);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${role}`;
  return {
    url: parsed.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${role}`);
      await c.end();
    },
  };
}

const inTenant = <T>(t: Tenant | null, fn: () => Promise<T>): Promise<T> => (t ? withTenant(t, fn) : fn());

async function seed(store: SessionStore, t: Tenant | null, label: string, sessions: number): Promise<string[]> {
  return inTenant(t, async () => {
    const ids: string[] = [];
    for (let i = 0; i < sessions; i++) {
      const session = await store.getOrCreateByThread(
        `${label}-${i}-${randomUUID()}`,
        "dm",
        scopeId("personal", label),
      );
      await store.addParticipant(session.id, `${label}-user`);
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      for (let n = 0; n <= i; n++) await store.append(lease, { kind: "UserMessage", text: `${label} ${n}` });
      await store.releaseLease(lease);
      ids.push(session.id);
    }
    return ids;
  });
}

const turnsOf = (store: SessionStore, t: Tenant | null) =>
  inTenant(t, async () =>
    (await store.attributedTurns())
      .map((r) => `${r.principalId}:${r.turns}`)
      .sort()
      .join(" "),
  );

test("attributed turns: every tenant's Admin Users counts survive the attributed_turns seed on a tenantized database", async () => {
  const { url, drop } = await provision();
  configurePgTenancy(true);
  const bypass = new pg.Client({ connectionString: url, options: TENANT_BYPASS_OPTION });
  try {
    const other = tenantFor("org-other", randomUUID(), "other");
    const first = createPostgresSessionStore(url);
    await seed(first, null, "home", 2);
    const otherSessions = await seed(first, other, "other", 3);
    const want = { home: await turnsOf(first, null), other: await turnsOf(first, other) };
    assert.equal(want.home, "home-user:1 home-user:2");
    assert.equal(want.other, "other-user:1 other-user:2 other-user:3");

    // Replay what a tenantized production database went through when attributed_turns first shipped: the
    // tables arrive by migration (tenancy bypassed, before qm_tenantize), over existing rows of several tenants.
    await bypass.connect();
    await bypass.query(`DROP TABLE attributed_turns, attributed_turns_dirty`);
    await bypass.query(`DROP FUNCTION mark_attribution_dirty() CASCADE`);
    await bypass.query(
      `DELETE FROM qm_schema_migrations WHERE id LIKE 'sessions/store/0048-%' OR id LIKE 'sessions/store/0049-%'`,
    );
    const reborn = new globalThis.URL(url);
    reborn.searchParams.set("application_name", "qm-reboot");
    const second = createPostgresSessionStore(reborn.toString());

    // The home tenant's admin page loads first, as it did on StyleUp.
    assert.equal(await turnsOf(second, null), want.home);
    assert.equal(await turnsOf(second, other), want.other, "a non-home tenant keeps its turn counts");

    // A write made with tenancy bypassed (a tenant import) marks the session dirty under its own tenant.
    await bypass.query(
      `INSERT INTO participants(tenant_id, session_id, principal_id, valid_from) VALUES ($1, $2, 'imported-user', 0)`,
      [other.id, otherSessions[2]],
    );
    const marks = await bypass.query(`SELECT tenant_id::text AS t FROM attributed_turns_dirty WHERE session_id = $1`, [
      otherSessions[2],
    ]);
    assert.deepEqual(
      marks.rows.map((r) => r.t),
      [other.id],
    );
    assert.equal(await turnsOf(second, other), `imported-user:3 ${want.other}`);
    assert.equal(await turnsOf(second, null), want.home);

    // A database that already ran the old seed and was tenantized (StyleUp after 0048): the other tenant's cache is
    // empty and its sessions' dirty marks sit under the home tenant. Applying 0049 there re-seeds every tenant.
    const home = (await bypass.query(`SELECT id::text AS id FROM qm_tenant`)).rows[0].id as string;
    await bypass.query(`DELETE FROM attributed_turns WHERE tenant_id = $1`, [other.id]);
    await bypass.query(
      `INSERT INTO attributed_turns_dirty(tenant_id, session_id)
         SELECT $1, session_id FROM participants WHERE tenant_id = $2 ON CONFLICT DO NOTHING`,
      [home, other.id],
    );
    await bypass.query(`DELETE FROM qm_schema_migrations WHERE id LIKE 'sessions/store/0049-%'`);
    assert.equal(await turnsOf(second, other), "", "the other tenant's cache starts empty, as on StyleUp");
    reborn.searchParams.set("application_name", "qm-fix-forward");
    const third = createPostgresSessionStore(reborn.toString());
    assert.equal(await turnsOf(third, null), want.home);
    assert.equal(await turnsOf(third, other), `imported-user:3 ${want.other}`);
    const stray = await bypass.query(
      `SELECT count(*)::int AS n FROM attributed_turns_dirty d JOIN participants p
           ON p.session_id = d.session_id AND p.tenant_id <> d.tenant_id`,
    );
    assert.equal(stray.rows[0].n, 0, "no dirty mark is left under another tenant");
  } finally {
    configurePgTenancy(false);
    await bypass.end().catch(() => undefined);
    await drop();
  }
});

async function tenantize(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await applyTenancy(pool);
  } finally {
    await pool.end();
  }
}

test("qm_tenantize rebuilds unique indexes and foreign keys from the catalog, keeping every clause", async () => {
  const { url, drop } = await provision();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE parents(id INT PRIMARY KEY, code TEXT, note TEXT, extra INT)`);
    await client.query(
      `CREATE UNIQUE INDEX parents_code_ix ON parents (lower(code) text_pattern_ops DESC NULLS LAST, (extra + 1))
         INCLUDE (note) WITH (fillfactor = 70) WHERE extra > 0`,
    );
    await client.query(`ALTER TABLE parents ADD CONSTRAINT parents_code_note UNIQUE NULLS NOT DISTINCT (code, note)`);
    await client.query(
      `CREATE TABLE children(
         id INT PRIMARY KEY,
         parent_id INT REFERENCES parents(id) ON DELETE SET NULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
         pinned_id INT NOT NULL REFERENCES parents(id) MATCH FULL ON DELETE RESTRICT,
         defaulted_id INT DEFAULT 0 REFERENCES parents(id) ON DELETE SET DEFAULT
       )`,
    );
    await client.query(
      `ALTER TABLE children ADD CONSTRAINT children_pending FOREIGN KEY (pinned_id) REFERENCES parents(id) NOT VALID`,
    );
    await tenantize(url);
    const indexes = await client.query(
      `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indrelid = 'parents'::regclass ORDER BY 1`,
    );
    assert.deepEqual(
      indexes.rows.map((r) => r.def),
      [
        "CREATE UNIQUE INDEX parents_code_ix ON public.parents USING btree (tenant_id, lower(code) text_pattern_ops DESC NULLS LAST, ((extra + 1))) INCLUDE (note) WITH (fillfactor='70') WHERE (extra > 0)",
        "CREATE UNIQUE INDEX parents_code_note ON public.parents USING btree (tenant_id, code, note) NULLS NOT DISTINCT",
        "CREATE UNIQUE INDEX parents_pkey ON public.parents USING btree (tenant_id, id)",
      ],
    );
    const constraints = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'children'::regclass AND contype = 'f' ORDER BY conname`,
    );
    assert.deepEqual(
      constraints.rows.map((r) => `${r.conname}: ${r.def}`),
      [
        "children_defaulted_id_fkey: FOREIGN KEY (tenant_id, defaulted_id) REFERENCES parents(tenant_id, id) ON DELETE SET DEFAULT (defaulted_id)",
        "children_parent_id_fkey: FOREIGN KEY (tenant_id, parent_id) REFERENCES parents(tenant_id, id) ON UPDATE CASCADE ON DELETE SET NULL (parent_id) DEFERRABLE INITIALLY DEFERRED",
        "children_pending: FOREIGN KEY (tenant_id, pinned_id) REFERENCES parents(tenant_id, id) NOT VALID",
        "children_pinned_id_fkey: FOREIGN KEY (tenant_id, pinned_id) REFERENCES parents(tenant_id, id) MATCH FULL ON DELETE RESTRICT",
      ],
    );
    await client.query(`INSERT INTO parents(id, code, extra) VALUES (1, 'a', 1), (2, 'b', 2)`);
    await client.query(`INSERT INTO children(id, parent_id, pinned_id, defaulted_id) VALUES (1, 1, 2, 2)`);
    await client.query(`DELETE FROM parents WHERE id = 1`);
    const left = await client.query(`SELECT parent_id, pinned_id, tenant_id = qm_tenant_id() AS own FROM children`);
    assert.deepEqual(left.rows, [{ parent_id: null, pinned_id: 2, own: true }]);
  } finally {
    await client.end();
    await drop();
  }
});

test("acl_grants_version bumps per tenant once the database is tenantized", async () => {
  const { url, drop } = await provision();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE acl_grants_version(only_row BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (only_row), v BIGINT NOT NULL)`,
    );
    await client.query(`CREATE TABLE acl_grants(id INT PRIMARY KEY)`);
    await client.query(
      `CREATE FUNCTION acl_grants_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
           ON CONFLICT (only_row) DO UPDATE SET v = acl_grants_version.v + 1;
           RETURN NULL;
         END $$`,
    );
    await client.query(
      `CREATE TRIGGER acl_grants_bump AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON acl_grants
         FOR EACH STATEMENT EXECUTE FUNCTION acl_grants_bump_version()`,
    );
    await tenantize(url);
    const other = randomUUID();
    await client.query(`INSERT INTO acl_grants(id) VALUES (1)`);
    await client.query(`INSERT INTO acl_grants(id) VALUES (2)`);
    await client.query(`SELECT set_config('qm.tenant_id', $1, false)`, [other]);
    await client.query(`INSERT INTO acl_grants(id) VALUES (1)`);
    await client.query(`SELECT set_config('qm.tenant_id', '', false)`);
    const versions = await client.query(
      `SELECT tenant_id = qm_tenant_id() AS home, v::int AS v FROM acl_grants_version ORDER BY home`,
    );
    assert.deepEqual(versions.rows, [{ home: true, v: 2 }]);
    await client.query(`SELECT set_config('qm.tenant_id', $1, false)`, [other]);
    const theirs = await client.query(`SELECT v::int AS v FROM acl_grants_version`);
    assert.deepEqual(theirs.rows, [{ v: 1 }]);
  } finally {
    await client.end();
    await drop();
  }
});
