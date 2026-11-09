import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { USER_SCHEMA_MIGRATIONS, createPostgresUserStore } from "../src/identity/user-store.ts";
import {
  applyPgMigrations,
  createPgPool,
  definePgMigration,
  migrateRegisteredPgSchemas,
  type PgPool,
} from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { createPostgresPersonaStore } from "../src/personas/persona-store.ts";
import { scopeId } from "../src/types.ts";
import { testBareDatabaseUrl, testMigratedDatabaseUrl } from "./support/test-database.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";

type Rows = Record<string, unknown>[];

async function upgrade(owner: PgPool): Promise<void> {
  const pool = await owner.pool();
  await applyPgMigrations(pool, USER_SCHEMA_MIGRATIONS.map(definePgMigration));
}

async function beforeUsers(owner: PgPool, linksTenanted: boolean): Promise<void> {
  await owner.q(`DROP TABLE users, user_links, personas, persona_access, persona_versions CASCADE`);
  await owner.q(`DELETE FROM qm_schema_migrations WHERE id LIKE 'users/%'`);
  await owner.q(
    linksTenanted
      ? `CREATE TABLE principal_links(tenant_id UUID NOT NULL, id TEXT NOT NULL, json JSONB NOT NULL,
           PRIMARY KEY (tenant_id, id))`
      : `CREATE TABLE principal_links(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
  );
}

async function fixture(): Promise<{ owner: PgPool; databaseUrl: string; close(): Promise<void> }> {
  const databaseUrl = testMigratedDatabaseUrl();
  const owner = createPgPool(ownerUrl(databaseUrl).toString());
  return { owner, databaseUrl, close: () => owner.close() };
}

async function turn(owner: PgPool, tenant: string, author: string, at: string): Promise<void> {
  const session = `s-${randomUUID()}`;
  await owner.q(
    `INSERT INTO sessions(tenant_id, id, type, scope_id, thread_ref, created_at, origin)
     VALUES ($1, $2, 'dm', 'personal:x', $2, 0, 'conversation')`,
    [tenant, session],
  );
  await owner.q(
    `INSERT INTO items(tenant_id, session_id, seq, kind, author, text, body, created_at)
     VALUES ($1, $2, 0, 'UserMessage', $3, 'hi', '{}', $4)`,
    [tenant, session, author, at],
  );
}

const linksOf = (owner: PgPool, tenant: string): Promise<Rows> =>
  owner.q(
    `SELECT l.alias_id, u.primary_alias FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
      WHERE l.tenant_id = $1 AND l.alias_id <> u.primary_alias ORDER BY l.alias_id COLLATE "C"`,
    [tenant],
  );

const usersOf = (owner: PgPool, tenant: string): Promise<Rows> =>
  owner.q(`SELECT primary_alias, source FROM users WHERE tenant_id = $1 ORDER BY primary_alias COLLATE "C"`, [tenant]);

test("a tenanted database builds each tenant's users from that tenant's own links, grants, invites and history", async () => {
  const { owner, databaseUrl, close } = await fixture();
  try {
    const [a, b] = [randomUUID(), randomUUID()];
    await owner.q(`INSERT INTO tenants(id) VALUES ($1), ($2)`, [a, b]);
    await beforeUsers(owner, true);
    await owner.q(
      `INSERT INTO principal_links(tenant_id, id, json) VALUES
        ($1, 'U1', '{"canonicalId":"pat@a.test","evidence":"verified","linkedBy":"admin@a.test","createdAt":1}'),
        ($2, 'U1', '{"canonicalId":"Quinn@B.test","evidence":"sso","linkedBy":"","createdAt":2}')`,
      [a, b],
    );
    await owner.q(
      `INSERT INTO admin_grants(tenant_id, principal_id, scope_id, role, created_at)
       VALUES ($1, 'admin@a.test', 'org:x', 'org_admin', 5)`,
      [a],
    );
    await owner.q(
      `INSERT INTO external_members(tenant_id, id, json)
       VALUES ($1, 'mate@b.test', '{"email":"mate@b.test","kind":"teammate","createdAt":1700000000000}')`,
      [b],
    );
    await owner.q(
      `INSERT INTO directory_members(tenant_id, org_id, principal_id, display_name, display_name_lc, type, slack_id)
       VALUES ($1, 'o', 'Five@A.test', 'Five', 'five', 'internal', 'U5')`,
      [a],
    );
    await turn(owner, a, "U1", "2026-01-01");
    await turn(owner, a, "U5", "2026-01-02");
    await turn(owner, b, "U1", "2026-01-03");

    await upgrade(owner);

    assert.deepEqual(
      (await linksOf(owner, a)).map((r) => [r.alias_id, r.primary_alias]),
      [
        ["U1", "pat@a.test"],
        ["U5", "five@a.test"],
      ],
    );
    assert.deepEqual(
      (await linksOf(owner, b)).map((r) => [r.alias_id, r.primary_alias]),
      [["U1", "quinn@b.test"]],
      "the same sign-in id belongs to a different person in each tenant",
    );
    assert.deepEqual(
      (await usersOf(owner, a)).map((r) => [r.primary_alias, r.source]),
      [
        ["admin@a.test", "admin"],
        ["five@a.test", "turn"],
        ["pat@a.test", "turn"],
      ],
    );
    assert.deepEqual(
      (await usersOf(owner, b)).map((r) => [r.primary_alias, r.source]),
      [
        ["mate@b.test", "invite"],
        ["quinn@b.test", "turn"],
      ],
    );
    const [linker] = await owner.q(
      `SELECT b.primary_alias FROM user_links l JOIN users b ON b.tenant_id = l.tenant_id AND b.id = l.linked_by
        WHERE l.tenant_id = $1 AND l.alias_id = 'U1'`,
      [a],
    );
    assert.equal(linker?.primary_alias, "admin@a.test");
    assert.deepEqual(await owner.q(`SELECT to_regclass('principal_links') AS p`), [{ p: null }]);
    assert.deepEqual(
      await owner.q(`SELECT count(*)::int AS n FROM users WHERE tenant_id <> ALL($1::uuid[])`, [[a, b]]),
      [{ n: 0 }],
      "no user lands in a tenant whose rows did not name it",
    );

    const users = createPostgresUserStore(appUrl(databaseUrl));
    assert.equal((await withTenant(a, () => users.get("U1")))?.principalId, "pat@a.test");
    assert.equal((await withTenant(b, () => users.get("U1")))?.principalId, "quinn@b.test");

    const before = await owner.q(`SELECT count(*)::int AS n FROM users`);
    await upgrade(owner);
    assert.deepEqual(await owner.q(`SELECT count(*)::int AS n FROM users`), before, "re-running changes nothing");
  } finally {
    await close();
  }
});

const SHAPE = `
  SELECT 'constraint' AS kind, c.conrelid::regclass::text AS tbl, c.conname AS name, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.conrelid IN ('users'::regclass, 'user_links'::regclass, 'personas'::regclass, 'persona_access'::regclass)
  UNION ALL
  SELECT 'index', i.tablename, i.indexname, i.indexdef FROM pg_indexes i
   WHERE i.schemaname = current_schema() AND i.tablename IN ('users', 'user_links', 'personas', 'persona_access')
  UNION ALL
  SELECT 'policy', p.tablename, p.policyname, p.qual || ' / ' || coalesce(p.with_check, '') FROM pg_policies p
   WHERE p.tablename IN ('users', 'user_links', 'personas', 'persona_access')
  UNION ALL
  SELECT 'column', c.table_name, c.column_name, c.data_type || ' ' || c.is_nullable || ' ' || coalesce(c.column_default, '')
    FROM information_schema.columns c
   WHERE c.table_schema = current_schema() AND c.table_name IN ('users', 'user_links', 'personas', 'persona_access')
  ORDER BY 1, 2, 3`;

test("a database that ran the single-tenant users tables gets the same tenant-first schema, its rows kept in its one tenant", async () => {
  const tenanted = await fixture();
  const upgraded = await fixture();
  try {
    const { owner } = upgraded;
    await owner.q(`DELETE FROM tenants`);
    await beforeUsers(owner, false);
    await owner.q(
      `INSERT INTO principal_links(id, json) VALUES ('U1', '{"canonicalId":"pat@a.test","evidence":"sso","createdAt":1}')`,
    );
    await upgrade(owner);
    const shape = await tenanted.owner.q(SHAPE);
    assert.deepEqual(
      shape.filter((row) => row.kind === "policy").map((row) => row.tbl),
      ["persona_access", "personas", "user_links", "users"],
    );
    assert.deepEqual(await owner.q(SHAPE), shape);
    const [only] = await owner.q(`SELECT id FROM tenants`);
    assert.deepEqual(
      (await linksOf(owner, String(only?.id))).map((r) => [r.alias_id, r.primary_alias]),
      [["U1", "pat@a.test"]],
    );
  } finally {
    await tenanted.close();
    await upgraded.close();
  }
});

test("users refuse to build when several tenants exist and a table they read has no tenant column", async () => {
  const { owner, close } = await fixture();
  try {
    await owner.q(`INSERT INTO tenants(id) VALUES ($1), ($2)`, [randomUUID(), randomUUID()]);
    await beforeUsers(owner, false);
    await assert.rejects(upgrade(owner), /several tenants exist/);
  } finally {
    await close();
  }
});

test("two tenants keep separate rosters and links under the login that does not own the tables", async () => {
  const { databaseUrl, owner, close } = await fixture();
  const app = createPgPool(appUrl(databaseUrl));
  try {
    const [a, b] = [randomUUID(), randomUUID()];
    await owner.q(`INSERT INTO tenants(id) VALUES ($1), ($2)`, [a, b]);
    const users = createPostgresUserStore(appUrl(databaseUrl));
    const link = { principalId: "U1", evidence: "sso", linkedBy: "", createdAt: 0 };
    await withTenant(a, () => users.link({ ...link, canonicalId: "pat@a.test" }));
    await withTenant(b, () => users.link({ ...link, canonicalId: "quinn@b.test" }));
    await withTenant(b, () => users.record({ id: "quinn@b.test", source: "turn", at: 1 }));
    await withTenant(a, () => users.markOffboarded("pat@a.test", "admin@a.test"));
    const linked = async (tenant: string) =>
      (await withTenant(tenant, () => users.links())).map((l) => [l.principalId, l.canonicalId]);
    assert.deepEqual(await linked(a), [["U1", "pat@a.test"]]);
    assert.deepEqual(await linked(b), [["U1", "quinn@b.test"]]);
    const roster = async (tenant: string) => (await withTenant(tenant, () => users.list())).map((u) => u.principalId);
    assert.deepEqual(await roster(a), ["pat@a.test"]);
    assert.deepEqual(await roster(b), ["quinn@b.test"]);
    assert.equal((await withTenant(b, () => users.unlink("U1")))?.canonicalId, "quinn@b.test");
    assert.equal((await withTenant(a, () => users.get("U1")))?.principalId, "pat@a.test");
    await assert.rejects(
      withTenant(a, () =>
        app.q(
          `INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at)
           SELECT $1, 'forged', user_id, 'x', now() FROM user_links WHERE alias_id = 'U1'`,
          [b],
        ),
      ),
      /row-level security/,
    );
  } finally {
    await app.close();
    await close();
  }
});

test("a bare database migrates in the order the server applies every registered migration", async () => {
  const databaseUrl = testBareDatabaseUrl();
  buildApp(testConfig({ databaseUrl }));
  await migrateRegisteredPgSchemas(databaseUrl);
  const owner = createPgPool(databaseUrl);
  try {
    assert.deepEqual(
      await owner.q(
        `SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c
          WHERE c.relname IN ('users', 'user_links', 'tenants') ORDER BY 1`,
      ),
      [
        { name: "tenants", rls: true },
        { name: "user_links", rls: true },
        { name: "users", rls: true },
      ],
    );
  } finally {
    await owner.close();
  }
});

test("a persona and its access list belong to the tenant that made them", async () => {
  const { databaseUrl, owner, close } = await fixture();
  try {
    const [a, b] = [randomUUID(), randomUUID()];
    await owner.q(`INSERT INTO tenants(id) VALUES ($1), ($2)`, [a, b]);
    const personas = createPostgresPersonaStore(appUrl(databaseUrl));
    const team = scopeId("org", "o");
    const made = await withTenant(a, () => personas.create({ name: "Reviewer" }, team, "pat@a.test"));
    await withTenant(b, () => personas.create({ name: "Reviewer" }, team, "pat@a.test"));
    assert.equal((await withTenant(a, () => personas.get(made.id)))?.name, "Reviewer");
    assert.equal(await withTenant(b, () => personas.get(made.id)), null);
    assert.deepEqual(
      (await withTenant(b, () => personas.listFor([team]))).map((p) => p.id === made.id),
      [false],
    );
    await withTenant(a, () => personas.replaceAccess(made.id, [{ scopeId: team, role: "owner" }], "pat@a.test"));
    assert.deepEqual(await withTenant(b, () => personas.access(made.id)), []);
  } finally {
    await close();
  }
});
