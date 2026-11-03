import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  configurePgPooling,
  createPgPool,
  migrateRegisteredPgSchemas,
  ownerDatabaseUrl,
} from "../src/persistence/pg-pool.ts";
import { setLoginPasswords } from "../src/persistence/login-passwords.ts";
import { scramVerifier } from "../cli/src/scram-verifier.ts";
import { derivedLoginPassword } from "../cli/src/database-logins.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the managed login password test";

test("scramVerifier emits a SCRAM-SHA-256 verifier and refuses non-ASCII passwords", () => {
  const verifier = scramVerifier("secret", Buffer.alloc(16, 1));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(verifier, scramVerifier("secret", Buffer.alloc(16, 1)));
  assert.notEqual(verifier, scramVerifier("secret"));
  assert.throws(() => scramVerifier("pässword"), /printable ASCII/);
});

const ROLES = `DO $$ BEGIN
  CREATE ROLE qm_app LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE qm_reader LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;

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

test(
  "the release step sets the qm_app and qm_reader passwords only when DATABASE_URL does not log in",
  { skip },
  async () => {
    const admin = new pg.Client({ connectionString: URL! });
    await admin.connect();
    try {
      await admin.query(ROLES);
      const appUrl = new globalThis.URL(URL!);
      appUrl.username = "qm_app";
      appUrl.password = randomBytes(24).toString("base64url");
      const readerUrl = new globalThis.URL(URL!);
      readerUrl.username = "qm_reader";
      readerUrl.password = derivedLoginPassword(decodeURIComponent(new globalThis.URL(URL!).password), "qm_reader");
      await admin.query(`ALTER ROLE qm_app PASSWORD '${scramVerifier(randomBytes(24).toString("base64url"))}'`);
      assert.equal(await logsIn(appUrl.toString()), false);
      assert.deepEqual(await setLoginPasswords(URL!, appUrl.toString()), ["qm_app", "qm_reader"]);
      assert.equal(await logsIn(appUrl.toString()), true);
      assert.equal(await logsIn(readerUrl.toString()), true);
      assert.deepEqual(await setLoginPasswords(URL!, appUrl.toString()), [], "a working login is left alone");
      const owner = new globalThis.URL(URL!);
      await assert.rejects(setLoginPasswords(URL!, owner.toString()), /DATABASE_URL must log in as qm_app/);
    } finally {
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
    appUrl.username = "qm_app";
    appUrl.password = password;
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(ROLES);
    configurePgPooling({ databaseUrl: appUrl.toString(), ownerUrl: ownerUrl.toString() });
    const store = createPgPool(appUrl.toString(), [
      {
        id: "0001_login_probe",
        statements: [
          `CREATE TABLE ${schema}.login_probe(id int)`,
          `GRANT USAGE ON SCHEMA ${schema} TO qm_app`,
          `GRANT SELECT, INSERT ON ${schema}.login_probe TO qm_app`,
        ],
      },
    ]);
    try {
      assert.equal(ownerDatabaseUrl(appUrl.toString()), ownerUrl.toString(), "pg-boss and migrations use the owner");
      assert.equal(ownerDatabaseUrl("postgres://other@db/x"), "postgres://other@db/x");
      await migrateRegisteredPgSchemas(appUrl.toString());
      await setLoginPasswords(ownerUrl.toString(), appUrl.toString());
      const owner = await admin.query(`SELECT tableowner FROM pg_tables WHERE schemaname = $1`, [schema]);
      assert.equal(owner.rows[0].tableowner, decodeURIComponent(ownerUrl.username));
      await store.q(`INSERT INTO login_probe VALUES (1)`);
      assert.deepEqual(await store.q(`SELECT current_user AS who, count(*)::int AS n FROM login_probe`), [
        { who: "qm_app", n: 1 },
      ]);
      await assert.rejects(store.q(`DROP TABLE login_probe`), /must be owner/);
    } finally {
      await store.close();
      configurePgPooling({});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
