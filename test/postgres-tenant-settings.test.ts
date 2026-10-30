import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgPool, migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { createTenantSettingsStore } from "../src/tenants/settings.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tenant settings test";
const KEY = "connector-key-".padEnd(48, "x");

async function withSettingsDb(
  fn: (ctx: { app: ReturnType<typeof createPgPool>; admin: pg.Pool; a: string; b: string }) => Promise<void>,
): Promise<void> {
  const schema = `tenant_settings_${randomUUID().replaceAll("-", "")}`;
  const role = `app_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = new globalThis.URL(URL!);
  schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: schemaUrl.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS`);
  createPostgresSessionStore(schemaUrl.toString());
  try {
    await migrateRegisteredPgSchemas(schemaUrl.toString());
    const a = String((await admin.query(`SELECT id::text AS id FROM tenants`)).rows[0].id);
    const b = randomUUID();
    await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'second', 'Second')`, [b]);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON tenant_settings TO ${role}`);
    await admin.query(`GRANT SELECT ON tenants TO ${role}`);
    const appUrl = new globalThis.URL(schemaUrl);
    appUrl.username = role;
    appUrl.password = "app";
    const app = createPgPool(appUrl.toString());
    try {
      await fn({ app, admin, a, b });
    } finally {
      await app.close();
    }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
}

test("tenant settings are stored per tenant, sealed at rest, and never read across tenants", { skip }, async () => {
  await withSettingsDb(async ({ app, admin, a, b }) => {
    const store = createTenantSettingsStore({ db: app, keyMaterial: KEY, harness: "pi", cacheMs: 0 });
    await withTenant(a, () => store.update({ SPRITES_TOKEN: "sprites-a", SANDBOX_BACKEND: "sprites", PI_MODEL: "m-a" }));
    await withTenant(b, () => store.update({ E2B_API_KEY: "e2b-b", SANDBOX_BACKEND: "e2b" }));
    const seenByA = await withTenant(a, () => store.get());
    const seenByB = await withTenant(b, () => store.get());
    assert.deepEqual(
      { token: seenByA.values.SPRITES_TOKEN, e2b: seenByA.values.E2B_API_KEY, backend: seenByA.sandboxBackend },
      { token: "sprites-a", e2b: undefined, backend: "sprites" },
    );
    assert.deepEqual(
      { token: seenByB.values.SPRITES_TOKEN, e2b: seenByB.values.E2B_API_KEY, backend: seenByB.sandboxBackend },
      { token: undefined, e2b: "e2b-b", backend: "e2b" },
    );
    const raw = await admin.query(`SELECT tenant_id::text AS tenant, sprites_token FROM tenant_settings ORDER BY 1`);
    const sealed = raw.rows.find((row) => row.tenant === a)!.sprites_token as Buffer;
    assert.ok(Buffer.isBuffer(sealed));
    assert.equal(sealed.includes(Buffer.from("sprites-a")), false);
    assert.equal((await withTenant(b, () => app.q(`SELECT tenant_id FROM tenant_settings`))).length, 1);
    await assert.rejects(app.q(`SELECT * FROM tenant_settings`), /No tenant is bound to this transaction/);
    const stolen = await withTenant(b, () =>
      app.q(`UPDATE tenant_settings SET pi_model = 'stolen' WHERE tenant_id = $1 RETURNING 1`, [a]),
    );
    assert.equal(stolen.length, 0);
    assert.equal((await withTenant(a, () => store.get())).piModel, "m-a");
  });
});

test("a sealed secret copied into another tenant's row does not open there", { skip }, async () => {
  await withSettingsDb(async ({ app, admin, a, b }) => {
    const store = createTenantSettingsStore({ db: app, keyMaterial: KEY, harness: "pi", cacheMs: 0 });
    await withTenant(a, () => store.update({ SPRITES_TOKEN: "sprites-a" }));
    await withTenant(b, () => store.update({ PI_MODEL: "m-b" }));
    await admin.query(
      `UPDATE tenant_settings SET sprites_token = (SELECT sprites_token FROM tenant_settings WHERE tenant_id = $1)
        WHERE tenant_id = $2`,
      [a, b],
    );
    await assert.rejects(withTenant(b, () => store.get()), /Unsupported state or unable to authenticate data/);
    assert.equal((await withTenant(a, () => store.get())).values.SPRITES_TOKEN, "sprites-a");
  });
});
