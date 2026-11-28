import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { migrateDatabase } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const MIGRATION = "migrations/0003-personal-scopes-by-user-id";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const ALICE_ELSEWHERE = "00000000-0000-4000-8000-00000000a11d";

async function seed(client: pg.Client): Promise<void> {
  await client.query("INSERT INTO tenants(id) VALUES ($1) ON CONFLICT DO NOTHING", [OTHER]);
  for (const [tenant, user, aliases] of [
    [TEST_TENANT, ALICE, ["alice@example.com", "U_ALICE"]],
    [OTHER, ALICE_ELSEWHERE, ["alice@example.com"]],
  ] as const) {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("INSERT INTO users(tenant_id, id, primary_alias) VALUES ($1, $2, $3)", [
      tenant,
      user,
      aliases[0],
    ]);
    for (const alias of aliases) {
      await client.query(
        "INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at) VALUES ($1, $2, $3, 'test', now())",
        [tenant, alias, user],
      );
    }
    await client.query("COMMIT");
  }
  const bind = (tenant: string) => client.query("SELECT set_config('qm.tenant_id', $1, false)", [tenant]);
  await bind(TEST_TENANT);
  await client.query(
    `INSERT INTO acl_grants(tenant_id, owner_scope_id, path, grantee_scope_id, permission, granted_by)
     VALUES ($1, 'personal: Alice@Example.com', '/a', 'personal:U_ALICE', 'read', 'test'),
            ($1, 'channel:C1', '/b', 'personal:${ALICE}', 'read', 'test')`,
    [TEST_TENANT],
  );
  await client.query(
    `INSERT INTO memory_facts(tenant_id, scope_id, text, sensitivity, source_unknown, created_at, updated_at, text_hash)
     VALUES ($1, 'personal:stranger@example.com', 'fact', 'normal', false, 1, 1, 'h')`,
    [TEST_TENANT],
  );
  await client.query(`INSERT INTO crons(tenant_id, id, json) VALUES ($1, 'c1', $2)`, [
    TEST_TENANT,
    {
      ownerScopeId: "personal:alice@example.com",
      backingScopeId: "personal:alice@example.com",
      audience: ["channel:C1", { scope: "personal:U_ALICE" }],
    },
  ]);
  await client.query(
    `INSERT INTO soul_configs(tenant_id, id, json) VALUES ($1, 'personal:alice@example.com', '{"soul": "a"}'),
                                                         ($1, 'personal:U_ALICE', '{"soul": "b"}')`,
    [TEST_TENANT],
  );
  await bind(OTHER);
  await client.query(
    `INSERT INTO acl_grants(tenant_id, owner_scope_id, path, grantee_scope_id, permission, granted_by)
     VALUES ($1, 'personal:alice@example.com', '/c', 'channel:C1', 'read', 'test')`,
    [OTHER],
  );
}

async function snapshot(client: pg.Client): Promise<unknown> {
  const rows = async (sql: string) => (await client.query(sql)).rows;
  return {
    acl: await rows(
      "SELECT tenant_id, owner_scope_id, path, grantee_scope_id FROM acl_grants ORDER BY tenant_id, path",
    ),
    facts: await rows("SELECT scope_id FROM memory_facts ORDER BY scope_id"),
    crons: await rows("SELECT json FROM crons ORDER BY id"),
    souls: await rows("SELECT id FROM soul_configs ORDER BY id"),
    users: await rows("SELECT tenant_id, id, primary_alias FROM users ORDER BY tenant_id, primary_alias"),
  };
}

async function rerun(client: pg.Client, url: string): Promise<void> {
  await client.query("DELETE FROM qm_schema_migrations WHERE id = $1", [MIGRATION]);
  await migrateDatabase(url);
}

test("0003-personal-scopes-by-user-id rekeys personal scopes by user id in batches and is idempotent", async () => {
  const url = testDatabaseUrl();
  const client = new pg.Client({ connectionString: ownerUrl(url).toString() });
  await client.connect();
  try {
    await seed(client);
    await rerun(client, url);
    const after = (await snapshot(client)) as {
      acl: { tenant_id: string; owner_scope_id: string; grantee_scope_id: string }[];
      facts: { scope_id: string }[];
      crons: { json: Record<string, unknown> }[];
      souls: { id: string }[];
      users: { tenant_id: string; id: string; primary_alias: string }[];
    };
    const stranger = after.users.find((u) => u.primary_alias === "stranger@example.com");
    assert.ok(stranger, "a scope that matched no one gets a user of its own");
    assert.deepEqual(
      after.acl.map((a) => [a.tenant_id, a.owner_scope_id, a.grantee_scope_id]),
      [
        [TEST_TENANT, `personal:${ALICE}`, `personal:${ALICE}`],
        [TEST_TENANT, "channel:C1", `personal:${ALICE}`],
        [OTHER, `personal:${ALICE_ELSEWHERE}`, "channel:C1"],
      ],
    );
    assert.deepEqual(after.facts, [{ scope_id: `personal:${stranger.id}` }]);
    assert.deepEqual(after.crons[0]!.json, {
      ownerScopeId: `personal:${ALICE}`,
      backingScopeId: "personal:alice@example.com",
      audience: ["channel:C1", { scope: `personal:${ALICE}` }],
    });
    assert.deepEqual(after.souls, [{ id: `personal:${ALICE}` }]);
    const [audit] = (
      await client.query(
        "SELECT detail::jsonb AS detail FROM audit_log WHERE action = 'personal_scopes_by_user_id' AND tenant_id = $1",
        [TEST_TENANT],
      )
    ).rows as { detail: { dropped: Record<string, number>; unmatched: { scope: string }[] } }[];
    assert.deepEqual(audit?.detail.dropped, { soul_configs: 1 });
    assert.deepEqual(
      audit?.detail.unmatched.map((u) => u.scope),
      ["personal:stranger@example.com"],
    );
    const leftovers = await client.query("SELECT to_regclass('qm_personal_scope_rekey_work') AS work");
    assert.deepEqual(leftovers.rows, [{ work: null }]);

    await rerun(client, url);
    assert.deepEqual(await snapshot(client), after);
  } finally {
    await client.end();
  }
});

test("0003-personal-scopes-by-user-id leaves a database that ran users/v2/0007 untouched", async () => {
  const url = testDatabaseUrl();
  const client = new pg.Client({ connectionString: ownerUrl(url).toString() });
  await client.connect();
  try {
    await seed(client);
    await client.query(
      "INSERT INTO qm_schema_migrations(id, checksum) VALUES ('users/v2/0007-personal-scopes-by-user-id', 'x')",
    );
    const before = await snapshot(client);
    await rerun(client, url);
    assert.deepEqual(await snapshot(client), before);
    const recorded = await client.query("SELECT 1 FROM qm_schema_migrations WHERE id = $1", [MIGRATION]);
    assert.equal(recorded.rowCount, 1);
  } finally {
    await client.end();
  }
});

test("0003-personal-scopes-by-user-id resumes from where a stopped run left off", async () => {
  const url = testDatabaseUrl();
  const client = new pg.Client({ connectionString: ownerUrl(url).toString() });
  await client.connect();
  try {
    await seed(client);
    await client.query(`CREATE FUNCTION fail_on_soul() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'stopped mid-run'; END $$`);
    await client.query(
      "CREATE TRIGGER fail_on_soul BEFORE UPDATE ON soul_configs FOR EACH ROW EXECUTE FUNCTION fail_on_soul()",
    );
    await client.query("DELETE FROM qm_schema_migrations WHERE id = $1", [MIGRATION]);
    await assert.rejects(migrateDatabase(url), /stopped mid-run/);
    const kept = await client.query("SELECT owner_scope_id FROM acl_grants WHERE path = '/a'");
    assert.deepEqual(kept.rows, [{ owner_scope_id: `personal:${ALICE}` }], "slices before the failure stay committed");
    const work = await client.query("SELECT count(*)::int AS done FROM qm_personal_scope_rekey_work WHERE done");
    assert.ok((work.rows[0] as { done: number }).done > 0);
    await client.query("DROP TRIGGER fail_on_soul ON soul_configs");
    await migrateDatabase(url);
    assert.deepEqual((await client.query("SELECT id FROM soul_configs")).rows, [{ id: `personal:${ALICE}` }]);
    const recorded = await client.query("SELECT 1 FROM qm_schema_migrations WHERE id = $1", [MIGRATION]);
    assert.equal(recorded.rowCount, 1);
  } finally {
    await client.end();
  }
});
