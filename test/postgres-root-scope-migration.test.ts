import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, createPgPool, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { composioNamespaceReader, tenantNameReader } from "../src/tenants/tenant-record.ts";
import { hashId } from "../src/util/crypto.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the root scope migration test";

const KV_TABLES = [
  "deployment_identity",
  "soul_configs",
  "keychain_credentials",
  "keychain_grants",
  "ambient_cursors",
  "keychain_asks",
];

const OWNED: Array<[string, string, Record<string, unknown>]> = [
  ["github", "env:GITHUB_TOKEN", { kind: "env", envKey: "GITHUB_TOKEN" }],
  ["warehouse", "env:A_KEY,B_KEY", { kind: "env", fields: [{ envKey: "B_KEY" }, { envKey: "A_KEY" }] }],
  ["gcloud", "file", { kind: "file" }],
  ["mail.example.com", "oauth:company", { kind: "env", host: "mail.example.com", refresh: { accountType: "company" } }],
  ["calendar.example.com", "oauth:", { kind: "env", host: "calendar.example.com", refresh: {} }],
];

test(
  "pg upgrade moves the old org id onto the tenant's root scope and drops the deployment identity",
  { skip },
  async () => {
    const schema = `root_scope_${randomUUID().replaceAll("-", "")}`;
    const schemaUrl = new globalThis.URL(URL!);
    schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
    const url = schemaUrl.toString();
    const raw = new pg.Pool({ connectionString: url });
    const app = createPgPool(url);
    try {
      await raw.query(`CREATE SCHEMA ${schema}`);
      createPostgresSessionStore(url);
      const migrations = registeredPgMigrations(url);
      await applyPgMigrations(
        raw,
        migrations.filter((migration) => migration.id < "sessions/store/0051"),
      );
      await raw.query("INSERT INTO tenants(id, slug, name) VALUES (gen_random_uuid(), 'main', 'Main')");
      for (const table of KV_TABLES) await raw.query(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      await raw.query(`CREATE TABLE org_rows(org_id TEXT NOT NULL, scope_label TEXT, scopes TEXT[], note TEXT)`);
      const oldBroker = hashId(["org:acme", "openai", "broker"]);
      await raw.query(`INSERT INTO deployment_identity VALUES ('singleton', '{"orgId":"acme"}')`);
      await raw.query(`INSERT INTO soul_configs VALUES ('org:acme', '{"scopeId":"org:acme","content":"x"}')`);
      await raw.query(`INSERT INTO keychain_credentials VALUES ($1, $2)`, [
        oldBroker,
        { id: oldBroker, ownerId: "org:acme", service: "openai", kind: "broker" },
      ]);
      await raw.query(`INSERT INTO keychain_grants VALUES ('g1', $1)`, [{ id: "g1", credentialId: oldBroker }]);
      for (const [service, slot, json] of OWNED) {
        const id = hashId(["org:acme", service, slot]);
        await raw.query(`INSERT INTO keychain_credentials VALUES ($1, $2)`, [
          id,
          { id, ownerId: "org:acme", service, ...json },
        ]);
      }
      const oldEnv = hashId(["org:acme", "github", "env:GITHUB_TOKEN"]);
      const oldAskGrant = hashId([oldEnv, "ask", "a1"]);
      await raw.query(`INSERT INTO keychain_grants VALUES ($1, $2)`, [
        oldAskGrant,
        { id: oldAskGrant, credentialId: oldEnv, askId: "a1" },
      ]);
      await raw.query(`INSERT INTO keychain_asks VALUES ('a1', $1)`, [
        { id: "a1", credentialId: oldEnv, grantId: oldAskGrant },
      ]);
      await raw.query(`INSERT INTO ambient_cursors VALUES ('acme:slack:C1', '{"lastJudgedTs":"1.0"}')`);
      await raw.query(
        `INSERT INTO org_rows VALUES ('acme', 'system:org:acme', ARRAY['org:acme', 'org:acme-labs'], 'prose about org:acme stays')`,
      );

      await applyPgMigrations(raw, migrations);
      await applyPgMigrations(raw, migrations);

      const tenant = String((await raw.query("SELECT id::text AS id FROM tenants")).rows[0].id);
      const root = `org:${tenant}`;
      const newBroker = hashId([root, "openai", "broker"]);
      assert.equal((await raw.query("SELECT to_regclass('deployment_identity') AS t")).rows[0].t, null);
      assert.deepEqual((await raw.query("SELECT id, json->>'scopeId' AS scope FROM soul_configs")).rows, [
        { id: root, scope: root },
      ]);
      const expected = [[root, "openai", "broker"], ...OWNED.map(([service, slot]) => [root, service, slot])].map(
        (parts) => hashId(parts),
      );
      assert.deepEqual(
        (
          await raw.query("SELECT id, json->>'id' AS self FROM keychain_credentials WHERE json->>'ownerId' = $1", [
            root,
          ])
        ).rows
          .map((row) => [row.id, row.self])
          .sort(),
        expected.map((id) => [id, id]).sort(),
      );
      const newEnv = hashId([root, "github", "env:GITHUB_TOKEN"]);
      const newAskGrant = hashId([newEnv, "ask", "a1"]);
      assert.deepEqual(
        (await raw.query("SELECT id, json FROM keychain_grants ORDER BY id")).rows,
        [
          { id: "g1", json: { id: "g1", credentialId: newBroker } },
          { id: newAskGrant, json: { id: newAskGrant, credentialId: newEnv, askId: "a1" } },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      assert.deepEqual((await raw.query("SELECT json FROM keychain_asks")).rows[0].json, {
        id: "a1",
        credentialId: newEnv,
        grantId: newAskGrant,
      });
      assert.equal((await raw.query("SELECT id FROM ambient_cursors")).rows[0].id, `${tenant}:slack:C1`);
      assert.deepEqual((await raw.query("SELECT * FROM org_rows")).rows, [
        {
          org_id: tenant,
          scope_label: `system:${root}`,
          scopes: [root, "org:acme-labs"],
          note: "prose about org:acme stays",
        },
      ]);
      const namespace = composioNamespaceReader(app);
      assert.equal(await withTenant(tenant, () => namespace()), "acme");
      assert.equal(await withTenant(tenant, () => tenantNameReader(app)()), "Main");
      await raw.query("UPDATE tenants SET composio_namespace = NULL");
      assert.equal(await withTenant(tenant, () => composioNamespaceReader(app)()), tenant);
    } finally {
      await app.close();
      await raw.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
      await raw.end();
    }
  },
);

test("pg upgrade with no tenant drops the deployment identity and moves nothing", { skip }, async () => {
  const schema = `root_scope_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = new globalThis.URL(URL!);
  schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: schemaUrl.toString() });
  try {
    await raw.query(`CREATE SCHEMA ${schema}`);
    createPostgresSessionStore(schemaUrl.toString());
    const migrations = registeredPgMigrations(schemaUrl.toString());
    await applyPgMigrations(
      raw,
      migrations.filter((migration) => migration.id < "sessions/store/0051"),
    );
    await raw.query("DELETE FROM tenants");
    await raw.query(`CREATE TABLE deployment_identity(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await raw.query(`CREATE TABLE soul_configs(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await raw.query(`INSERT INTO deployment_identity VALUES ('singleton', '{"orgId":"acme"}')`);
    await raw.query(`INSERT INTO soul_configs VALUES ('org:acme', '{"scopeId":"org:acme"}')`);
    await applyPgMigrations(raw, migrations);
    assert.equal((await raw.query("SELECT to_regclass('deployment_identity') AS t")).rows[0].t, null);
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
    assert.equal((await raw.query("SELECT id FROM soul_configs")).rows[0].id, "org:acme");
  } finally {
    await raw.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await raw.end();
  }
});

test("pg fresh install creates no tenant and later tenants start without a Composio namespace", { skip }, async () => {
  const schema = `root_scope_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = new globalThis.URL(URL!);
  schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
  const url = schemaUrl.toString();
  const raw = new pg.Pool({ connectionString: url });
  try {
    await raw.query(`CREATE SCHEMA ${schema}`);
    createPostgresSessionStore(url);
    await applyPgMigrations(raw, registeredPgMigrations(url));
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
    await raw.query("INSERT INTO tenants(id, slug, name) VALUES (gen_random_uuid(), 'main', 'Main')");
    assert.equal((await raw.query("SELECT composio_namespace FROM tenants")).rows[0].composio_namespace, null);
  } finally {
    await raw.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await raw.end();
  }
});
