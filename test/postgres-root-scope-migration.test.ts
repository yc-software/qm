import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, createPgPool, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { composioNamespaceReader } from "../src/tenants/composio-namespace.ts";
import { hashId } from "../src/util/crypto.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the root scope migration test";

const KV_TABLES = [
  "deployment_identity",
  "soul_configs",
  "keychain_credentials",
  "keychain_grants",
  "slack_installation",
  "ambient_cursors",
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
        migrations.filter((migration) => migration.id < "sessions/store/0048"),
      );
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
      await raw.query(`INSERT INTO slack_installation VALUES ('acme', '{"disabled":true}')`);
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
      assert.deepEqual(
        (await raw.query("SELECT id, json->>'ownerId' AS owner, json->>'id' AS self FROM keychain_credentials")).rows,
        [{ id: newBroker, owner: root, self: newBroker }],
      );
      assert.equal((await raw.query("SELECT json->>'credentialId' AS c FROM keychain_grants")).rows[0].c, newBroker);
      assert.equal((await raw.query("SELECT id FROM slack_installation")).rows[0].id, tenant);
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
      await raw.query("UPDATE tenants SET composio_namespace = NULL");
      assert.equal(await withTenant(tenant, () => composioNamespaceReader(app)()), tenant);
    } finally {
      await app.close();
      await raw.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
      await raw.end();
    }
  },
);

test("pg fresh install without a deployment identity just gains the namespace column", { skip }, async () => {
  const schema = `root_scope_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = new globalThis.URL(URL!);
  schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
  const url = schemaUrl.toString();
  const raw = new pg.Pool({ connectionString: url });
  try {
    await raw.query(`CREATE SCHEMA ${schema}`);
    createPostgresSessionStore(url);
    await applyPgMigrations(raw, registeredPgMigrations(url));
    const row = (await raw.query("SELECT id::text AS id, composio_namespace FROM tenants")).rows[0];
    assert.equal(row.composio_namespace, null);
  } finally {
    await raw.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await raw.end();
  }
});
