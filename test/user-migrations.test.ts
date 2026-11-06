import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { USER_MIGRATIONS } from "../src/identity/user-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

async function inSchema(fn: (q: (sql: string) => Promise<Record<string, any>[]>) => Promise<void>): Promise<void> {
  const schema = `users_mig_${randomUUID().slice(0, 8)}`;
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path = ${schema}, public`);
    await fn(async (sql) => (await client.query(sql)).rows);
  } finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
}

const migrate = async (q: (sql: string) => Promise<unknown>) => {
  for (const m of USER_MIGRATIONS) for (const statement of m.statements) await q(statement);
};

test("a database that ran the string-keyed users tables converts to generated ids, keeping links and history", async () => {
  await inSchema(async (q) => {
    await q(`CREATE TABLE sessions(id TEXT PRIMARY KEY, origin TEXT, parent_session_id TEXT, spawn_meta TEXT)`);
    await q(`CREATE TABLE items(session_id TEXT, author TEXT, kind TEXT, body JSONB, created_at TIMESTAMPTZ)`);
    await q(`CREATE TABLE directory_members(principal_id TEXT, slack_id TEXT)`);
    await q(`CREATE TABLE admin_grants(principal_id TEXT, created_at BIGINT)`);
    await q(`CREATE TABLE external_members(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await q(`CREATE TABLE durable_map_versions(tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`);
    await q(`CREATE TABLE users(tenant_id TEXT NOT NULL DEFAULT 't', id TEXT NOT NULL, first_seen_at TIMESTAMPTZ,
               source TEXT, offboarded_at TIMESTAMPTZ, offboarded_by TEXT, PRIMARY KEY (tenant_id, id))`);
    await q(`CREATE TABLE user_links(tenant_id TEXT NOT NULL DEFAULT 't', alias_id TEXT NOT NULL, user_id TEXT NOT NULL,
               evidence TEXT NOT NULL, linked_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
    await q(`CREATE TABLE principal_links(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);

    await q(`INSERT INTO users(id, first_seen_at, source, offboarded_at, offboarded_by) VALUES
      ('pat@example.com', '2026-01-02', 'turn', NULL, NULL),
      ('seven@example.com', '2026-01-03', 'turn', NULL, NULL),
      ('leaver@example.com', '2026-01-04', 'turn', '2026-02-01', 'admin-alice'),
      ('U9', '2026-01-05', 'turn', NULL, NULL)`);
    await q(`INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at) VALUES
      ('U1', 'pat@example.com', 'verified', 'admin-alice', '2026-01-02'),
      ('U7', 'seven@example.com', 'slack directory: slack_id→principal_id', 'migration', '2026-01-03')`);
    await q(`INSERT INTO principal_links VALUES
      ('U1', '{"principalId":"U1","canonicalId":"pat@example.com","evidence":"verified","linkedBy":"admin-alice","createdAt":1}'),
      ('bob@example.com', '{"principalId":"Bob@Example.com","canonicalId":"oidc:issuer:123","evidence":"sso","linkedBy":"admin-bob","createdAt":2}'),
      ('U3', '{"principalId":"U3","canonicalId":"pat@example.com","evidence":"same founder","linkedBy":"platform:founder-autolink","createdAt":4}'),
      ('self', '{"principalId":"self","canonicalId":"self","evidence":"x","linkedBy":"","createdAt":3}')`);
    await q(`INSERT INTO durable_map_versions VALUES ('principal_links', 4)`);
    await q(`INSERT INTO sessions VALUES ('s1', 'conversation', NULL, NULL),
      ('ext', 'conversation', NULL, '{"surfaceOrigin":{"audience":"external"}}'),
      ('cron', 'conversation', NULL, '{"origin":{"kind":"automation"}}'),
      ('child', 'conversation', 's1', NULL)`);
    await q(`INSERT INTO external_members VALUES
      ('mate@example.com', '{"email":"Mate@Example.com","kind":"teammate","createdAt":1700000000000}'),
      ('guest@partner.com', '{"email":"guest@partner.com","kind":"guest","createdAt":1700000000000}')`);
    await q(`INSERT INTO items VALUES
      ('s1', 'U1', 'UserMessage', '{}', '2026-01-01'),
      ('s1', 'U5', 'UserMessage', '{}', '2026-01-06'),
      ('s1', 'Bob@Example.com', 'UserMessage', '{}', '2026-01-07'),
      ('s1', 'U9', 'UserMessage', '{}', '2026-01-05'),
      ('s1', 'U-heard', 'UserMessage', '{"overheard":true}', '2026-01-05'),
      ('s1', 'system:cron', 'UserMessage', '{}', '2026-01-05'),
      ('ext', 'U-ext', 'UserMessage', '{}', '2026-01-05'),
      ('cron', 'U-cron', 'UserMessage', '{}', '2026-01-05'),
      ('child', 'U-child', 'UserMessage', '{}', '2026-01-05')`);
    await q(`INSERT INTO directory_members VALUES ('Five@Example.com', 'U5'), ('Seven@Example.com', 'U7')`);
    await q(`INSERT INTO admin_grants VALUES ('admin-alice', 5), ('admin-bob', 6)`);

    await migrate(q);

    const users = await q(
      `SELECT id::text, primary_alias, kind, source, first_seen_at, offboarded_at, offboarded_by::text FROM users`,
    );
    const byAlias = new Map(users.map((u) => [u.primary_alias as string, u]));
    for (const u of users) assert.match(u.id, /^[0-9a-f-]{36}$/);
    const links = await q(`SELECT l.alias_id, u.primary_alias FROM user_links l JOIN users u ON u.id = l.user_id
                            WHERE l.alias_id <> u.primary_alias ORDER BY l.alias_id COLLATE "C"`);
    assert.deepEqual(
      links.map((r) => [r.alias_id, r.primary_alias]),
      [
        ["U1", "pat@example.com"],
        ["U3", "pat@example.com"],
        ["U5", "five@example.com"],
        ["U7", "seven@example.com"],
        ["bob@example.com", "oidc:issuer:123"],
      ],
      "old links, restored links and a directory-mapped Slack author all point at the right user; self-links are dropped",
    );
    assert.deepEqual(
      [...byAlias.keys()].sort(),
      [
        "U9",
        "admin-alice",
        "admin-bob",
        "five@example.com",
        "leaver@example.com",
        "mate@example.com",
        "oidc:issuer:123",
        "pat@example.com",
        "seven@example.com",
      ],
      "no user for overheard, system, external-audience, automation or delegated-session authors",
    );
    assert.equal(
      (
        await q(`SELECT count(*)::int AS n FROM users u WHERE NOT EXISTS
                 (SELECT 1 FROM user_links l WHERE l.user_id = u.id AND l.alias_id = u.primary_alias)`)
      )[0]!.n,
      0,
      "every user's primary sign-in is one of their links",
    );
    assert.equal(
      new Date(byAlias.get("pat@example.com")!.first_seen_at).toISOString().slice(0, 10),
      "2026-01-01",
      "first-seen takes the earliest of the old row and history under any alias",
    );
    assert.equal(
      byAlias.get("oidc:issuer:123")!.source,
      "turn",
      "a person whose canonical is an oidc id gets their alias's history",
    );
    const [autolink] = await q(`SELECT evidence, linked_by FROM user_links WHERE alias_id = 'U3'`);
    assert.deepEqual(
      autolink,
      { evidence: "same founder (linked by platform:founder-autolink)", linked_by: null },
      "a system actor gets no user; the link keeps who made it in its evidence",
    );
    const leaver = byAlias.get("leaver@example.com")!;
    assert.equal(leaver.offboarded_by, byAlias.get("admin-alice")!.id, "offboarded_by points at the admin's user");
    assert.equal(byAlias.get("admin-alice")!.source, "admin");
    assert.equal(
      byAlias.get("mate@example.com")!.source,
      "invite",
      "an invited teammate gets a user; a guest does not",
    );
    assert.equal(
      byAlias.get("admin-bob")!.source,
      "admin",
      "a linker who holds an admin grant is resolved to their user",
    );
    const [bobLink] = await q(`SELECT linked_by::text FROM user_links WHERE alias_id = 'bob@example.com'`);
    assert.equal(bobLink!.linked_by, byAlias.get("admin-bob")!.id);
    assert.deepEqual(
      (await q(`SELECT to_regclass('principal_links') AS p, (SELECT count(*)::int FROM durable_map_versions) AS v`))[0],
      { p: null, v: 0 },
      "the old link map is gone",
    );

    const before = await q(`SELECT count(*)::int AS u, (SELECT count(*)::int FROM user_links) AS l FROM users`);
    await migrate(q);
    assert.deepEqual(
      await q(`SELECT count(*)::int AS u, (SELECT count(*)::int FROM user_links) AS l FROM users`),
      before,
      "re-running changes nothing",
    );
  });
});
