import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  composioUserId,
  createPostgresPrincipalStore,
  createPrincipalGraph,
  handle,
} from "../src/identity/principals.ts";
import { ensurePrincipalSchema, runIdentityMigration } from "../src/identity/migrate-identities.ts";
import { PRINCIPAL_REFS } from "../src/identity/principal-refs.ts";

const BASE_URL = process.env.DATABASE_URL;
const skip = BASE_URL ? false : "set DATABASE_URL (a Postgres) to run identity tests";
const parent = BASE_URL ? new URL(BASE_URL).pathname.slice(1) : "";
const prefix = /^qmt_\w+$/.test(parent) ? parent : "qm";
const silent = () => {};

async function freshDb(): Promise<{ url: string; pool: Pool; drop: () => Promise<void> }> {
  const pg = (await import("pg")).default;
  const name = `${prefix}_ident_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: BASE_URL });
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(BASE_URL!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(`
    CREATE TABLE participants(session_id TEXT NOT NULL, principal_id TEXT NOT NULL, PRIMARY KEY(session_id, principal_id));
    CREATE TABLE sessions(id TEXT PRIMARY KEY, scope_id TEXT, thread_ref TEXT);
    CREATE TABLE admin_grants(principal_id TEXT NOT NULL, scope_id TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT,
      PRIMARY KEY(principal_id, scope_id));
    CREATE TABLE memory_revisions(id BIGSERIAL PRIMARY KEY, scope_id TEXT NOT NULL, seq BIGINT NOT NULL, op TEXT NOT NULL,
      body TEXT NOT NULL, author TEXT, at BIGINT NOT NULL, records JSONB, UNIQUE(scope_id, seq));
    CREATE TABLE directory_members(org_id TEXT NOT NULL, principal_id TEXT NOT NULL, display_name TEXT, slack_id TEXT,
      PRIMARY KEY(org_id, principal_id));
    CREATE TABLE sandbox_defaults(id TEXT PRIMARY KEY, json JSONB NOT NULL);
    CREATE TABLE crons(id TEXT PRIMARY KEY, json JSONB NOT NULL);
    CREATE TABLE principal_links(id TEXT PRIMARY KEY, json JSONB NOT NULL);
  `);
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Pool({ connectionString: BASE_URL });
      await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await a.end();
    },
  };
}

let db: Awaited<ReturnType<typeof freshDb>> | null = null;
before(async () => {
  if (BASE_URL) db = await freshDb();
});
after(async () => {
  await db?.drop();
});

test(
  "combine re-points every reference, keeps A on singleton clashes, interleaves the notebooks, deletes B",
  { skip },
  async () => {
    const { pool, url } = db!;
    await ensurePrincipalSchema(pool);
    const graph = createPrincipalGraph(createPostgresPrincipalStore(url));
    const a = await graph.act(handle("oidc", "oidc:alice"));
    const b = await graph.act(handle("slack", "U0ALICE"));
    const seed: [string, string[]][] = [
      ["INSERT INTO participants VALUES ('s1', $1), ('s1', $2), ('s2', $2)", [a, b]],
      ["INSERT INTO sessions VALUES ('s2', 'personal:' || $1, 'web:personal:' || $1 || ':s2')", [b]],
      [
        `INSERT INTO memory_revisions(scope_id, seq, op, body, at) VALUES ('personal:' || $1, 1, 'w', 'A one', 1),
       ('personal:' || $1, 2, 'w', 'A two', 2), ('personal:' || $2, 1, 'w', 'B one', 3)`,
        [a, b],
      ],
      [
        `INSERT INTO sandbox_defaults VALUES ('personal:' || $1, '{"box":"a"}'), ('personal:' || $2, '{"box":"b"}')`,
        [a, b],
      ],
      ["INSERT INTO crons VALUES ('c1', jsonb_build_object('scope', 'personal:' || $1::text, 'owner', $1::text))", [b]],
    ];
    for (const [sql, params] of seed) await pool.query(sql, params);

    await graph.combine(a, b);

    const q = async (sql: string) => (await pool.query(sql)).rows;
    assert.deepEqual(await q("SELECT session_id, principal_id FROM participants ORDER BY 1"), [
      { session_id: "s1", principal_id: a },
      { session_id: "s2", principal_id: a },
    ]);
    assert.deepEqual(await q("SELECT scope_id, thread_ref FROM sessions"), [
      { scope_id: `personal:${a}`, thread_ref: `web:personal:${a}:s2` },
    ]);
    assert.deepEqual(await q("SELECT id, json FROM sandbox_defaults"), [{ id: `personal:${a}`, json: { box: "a" } }]);
    assert.deepEqual((await q("SELECT json FROM crons"))[0]!.json, { scope: `personal:${a}`, owner: a });
    const memory = await q(`SELECT seq::int, body FROM memory_revisions WHERE scope_id = 'personal:${a}' ORDER BY seq`);
    assert.deepEqual(
      memory.map((r) => [r.seq, r.body]),
      [
        [1, "A one\n"],
        [2, "A two\n"],
        [3, "A two\n\nB one\n"],
      ],
      "one history in time order, no trailing join revision",
    );
    assert.deepEqual(await q(`SELECT 1 FROM memory_revisions WHERE scope_id = 'personal:${b}'`), []);
    assert.equal(graph.principalOf(handle("slack", "U0ALICE")), a);
    const other = createPrincipalGraph(createPostgresPrincipalStore(url));
    await other.refresh(true);
    assert.equal(other.principalOf(handle("slack", "U0ALICE")), a);
    await graph.attach(handle("email", "alice@acme.test"), a, "test");
    await other.refresh(true);
    assert.equal(other.principalOf(handle("email", "alice@acme.test")), a, "a write elsewhere bumps the version");
    assert.deepEqual(await q(`SELECT 1 FROM principals WHERE principal_id = '${b}'`), []);
  },
);

test(
  "migration groups linked handles, rewrites every registered reference and drops principal_links",
  { skip },
  async () => {
    const fresh = await freshDb();
    try {
      const { pool } = fresh;
      await pool.query(`
      INSERT INTO principal_links VALUES ('oidc:pranav', '{"principalId":"oidc:pranav","canonicalId":"pranav@acme.test"}');
      INSERT INTO directory_members VALUES ('org', 'pranav@acme.test', 'Pranav', 'U0PRANAV'),
        ('org', 'jonathan@acme.test', 'Jonathan', 'U0JON');
      INSERT INTO participants VALUES ('s1', 'oidc:pranav'), ('s1', 'pranav@acme.test'), ('s2', 'U0JON');
      INSERT INTO sessions VALUES ('s1', 'personal:oidc:pranav', 'web:personal:oidc:pranav:s1');
      INSERT INTO admin_grants VALUES ('pranav@acme.test', 'org:acme', 'admin', 'oidc:pranav');
      INSERT INTO memory_revisions(scope_id, seq, op, body, at) VALUES
        ('personal:pranav@acme.test', 1, 'w', 'slack side', 1), ('personal:oidc:pranav', 1, 'w', 'web side', 2);
      INSERT INTO sandbox_defaults VALUES ('personal:jonathan@acme.test', '{"box":"slack"}'),
        ('personal:U0JON', '{"box":"web"}');
      INSERT INTO crons VALUES ('c1', '{"scope":"personal:oidc:pranav","task":"email pranav@acme.test daily"}');
    `);
      await ensurePrincipalSchema(pool);
      const dry = await runIdentityMigration({ pool, apply: false, log: silent });
      assert.equal(dry.principals, 2);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0].n, 0);

      const report = await runIdentityMigration({ pool, apply: true, org: "org_test", log: silent });
      assert.equal(report.principals, 2);
      assert.equal(report.notebooksMerged, 1);
      const ids = (await pool.query("SELECT provider, external_id, principal_id FROM identities ORDER BY 1, 2")).rows;
      const pranav = ids.find((r) => r.external_id === "oidc:pranav")!.principal_id;
      const jonathan = ids.find((r) => r.external_id === "U0JON")!.principal_id;
      assert.equal(ids.find((r) => r.external_id === "pranav@acme.test")!.principal_id, pranav);
      assert.equal(ids.find((r) => r.external_id === "U0PRANAV")!.principal_id, pranav);
      assert.equal(ids.find((r) => r.external_id === "jonathan@acme.test")!.principal_id, jonathan);

      const q = async (sql: string) => (await pool.query(sql)).rows;
      assert.deepEqual(await q("SELECT principal_id FROM participants ORDER BY session_id, principal_id"), [
        { principal_id: pranav },
        { principal_id: jonathan },
      ]);
      assert.deepEqual(await q("SELECT scope_id, thread_ref FROM sessions"), [
        { scope_id: `personal:${pranav}`, thread_ref: `web:personal:${pranav}:s1` },
      ]);
      assert.deepEqual(await q("SELECT principal_id, granted_by FROM admin_grants"), [
        { principal_id: pranav, granted_by: pranav },
      ]);
      const memory = await q("SELECT scope_id, body FROM memory_revisions ORDER BY seq");
      assert.ok(memory.every((r) => r.scope_id === `personal:${pranav}`));
      assert.deepEqual(
        memory.map((r) => r.body),
        ["slack side\n", "slack side\n\nweb side\n"],
        "interleaved by time with no trailing join revision",
      );

      const graph = createPrincipalGraph(createPostgresPrincipalStore(fresh.url));
      await graph.refresh(true);
      for (const legacy of ["oidc:pranav", "pranav@acme.test", "U0PRANAV"])
        assert.equal(
          graph.principalOf(handle("composio", composioUserId("org_test", legacy))),
          pranav,
          `a Composio connection made as ${legacy} before the migration still resolves to its owner`,
        );
      assert.equal((await q("SELECT id FROM sandbox_defaults")).length, 1);
      assert.equal((await q("SELECT id FROM sandbox_defaults"))[0]!.id, `personal:${jonathan}`);
      assert.deepEqual((await q("SELECT json FROM crons"))[0]!.json, {
        scope: `personal:${pranav}`,
        task: "email pranav@acme.test daily",
      });
      assert.deepEqual(await q("SELECT to_regclass('principal_links') AS t"), [{ t: null }]);
      assert.ok((await q("SELECT to_regclass('identity_premigration_participants') AS t"))[0]!.t);

      const old = ["oidc:pranav", "pranav@acme.test", "U0PRANAV", "jonathan@acme.test", "U0JON"];
      for (const r of PRINCIPAL_REFS) {
        const exists = await q(
          `SELECT 1 FROM information_schema.columns WHERE table_name = '${r.table}' AND column_name = '${r.column}'`,
        );
        if (!exists.length || r.table === "identities") continue;
        for (const id of old) {
          const hits = (await pool.query(`SELECT 1 FROM "${r.table}" WHERE strpos("${r.column}"::text, $1) > 0`, [id]))
            .rows;
          assert.deepEqual(hits, [], `${r.table}.${r.column} still holds ${id}`);
        }
      }
    } finally {
      await fresh.drop();
    }
  },
);
