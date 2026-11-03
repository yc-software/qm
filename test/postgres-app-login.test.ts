import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  configurePgPooling,
  createPgPool,
  migrateRegisteredPgSchemas,
  ownerDatabaseUrl,
  registerPgMigrations,
} from "../src/persistence/pg-pool.ts";
import { ensureAppLogin } from "../src/persistence/app-login.ts";
import { scramVerifier } from "../cli/src/scram-verifier.ts";

const URL = process.env.DATABASE_OWNER_URL;
const skip = URL ? false : "set DATABASE_OWNER_URL (a Postgres superuser) to run the managed login password test";

test("scramVerifier emits a SCRAM-SHA-256 verifier and refuses non-ASCII passwords", () => {
  const verifier = scramVerifier("secret", Buffer.alloc(16, 1));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(verifier, scramVerifier("secret", Buffer.alloc(16, 1)));
  assert.notEqual(verifier, scramVerifier("secret"));
  assert.throws(() => scramVerifier("pässword"), /printable ASCII/);
});

async function logsIn(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: unknown }).code === "28P01") return false;
    throw error;
  }
  await client.end();
  return true;
}

function loginUrl(name: string, password: string): string {
  const url = new globalThis.URL(URL!);
  url.username = name;
  url.password = password;
  return url.toString();
}

test(
  "the release step creates the login DATABASE_URL names and never resets an existing login's password",
  { skip },
  async () => {
    const admin = new pg.Client({ connectionString: URL! });
    await admin.connect();
    const name = `qm-app-${randomUUID().slice(0, 8)}`;
    try {
      const appUrl = loginUrl(name, randomBytes(24).toString("base64url"));
      assert.equal(await ensureAppLogin(URL!, appUrl), "created");
      assert.equal(await logsIn(appUrl), true);
      const role = await admin.query(
        "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1",
        [name],
      );
      assert.deepEqual(role.rows[0], {
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
      assert.equal(await ensureAppLogin(URL!, appUrl), "unchanged", "a working login is left alone");
      const other = loginUrl(name, randomBytes(24).toString("base64url"));
      await assert.rejects(ensureAppLogin(URL!, other), /exists but refuses DATABASE_URL's password/);
      assert.equal(await logsIn(appUrl), true, "another deployment's password is never reset");
      await assert.rejects(
        ensureAppLogin(URL!, URL!),
        /is the table owner|the table owner; give it a login of its own/,
      );
      await assert.rejects(ensureAppLogin(URL!, loginUrl("x".repeat(64), "p")), /longer than the 63 bytes/);
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(name)}`);
      await admin.end();
    }
  },
);

test(
  "migrations run as the owner login and the app login connects with its configured password",
  { skip },
  async () => {
    const schema = `logins_${randomUUID().replaceAll("-", "")}`;
    const ownerUrl = new globalThis.URL(URL!);
    ownerUrl.searchParams.set("options", `-c search_path=${schema}`);
    const admin = new pg.Pool({ connectionString: ownerUrl.toString() });
    const password = randomBytes(24).toString("base64url");
    const appUrl = new globalThis.URL(ownerUrl);
    appUrl.username = `${schema}_app`;
    appUrl.password = password;
    await admin.query(`CREATE SCHEMA ${schema}`);
    await ensureAppLogin(ownerUrl.toString(), appUrl.toString());
    configurePgPooling({ databaseUrl: appUrl.toString(), ownerUrl: ownerUrl.toString() });
    registerPgMigrations(ownerUrl.toString(), [
      {
        id: "0001_login_probe",
        statements: [
          `CREATE TABLE ${schema}.login_probe(id int)`,
          `GRANT USAGE ON SCHEMA ${schema} TO ${schema}_app`,
          `GRANT SELECT, INSERT ON ${schema}.login_probe TO ${schema}_app`,
        ],
      },
    ]);
    const store = createPgPool(appUrl.toString());
    try {
      assert.equal(ownerDatabaseUrl(appUrl.toString()), ownerUrl.toString(), "pg-boss and migrations use the owner");
      assert.equal(ownerDatabaseUrl("postgres://other@db/x"), "postgres://other@db/x");
      await migrateRegisteredPgSchemas(ownerUrl.toString());
      const owner = await admin.query(`SELECT tableowner FROM pg_tables WHERE schemaname = $1`, [schema]);
      assert.equal(owner.rows[0].tableowner, decodeURIComponent(ownerUrl.username));
      await store.q(`INSERT INTO login_probe VALUES (1)`);
      assert.deepEqual(await store.q(`SELECT current_user AS who, count(*)::int AS n FROM login_probe`), [
        { who: `${schema}_app`, n: 1 },
      ]);
      await assert.rejects(store.q(`DROP TABLE login_probe`), /must be owner/);
    } finally {
      await store.close();
      configurePgPooling({});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP ROLE ${schema}_app`);
      await admin.end();
    }
  },
);
