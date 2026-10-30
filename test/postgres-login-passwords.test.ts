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
import { setLoginPasswords, setPoolLoginPasswords } from "../src/persistence/login-passwords.ts";
import { scramVerifier } from "../cli/src/scram-verifier.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the managed login password test";

test("scramVerifier emits a SCRAM-SHA-256 verifier and refuses non-ASCII passwords", () => {
  const verifier = scramVerifier("secret", Buffer.alloc(16, 1));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(verifier, scramVerifier("secret", Buffer.alloc(16, 1)));
  assert.notEqual(verifier, scramVerifier("secret"));
  assert.throws(() => scramVerifier("pässword"), /printable ASCII/);
});

test("setLoginPasswords only touches qm_app and qm_reader and reports missing roles", async () => {
  const statements: string[] = [];
  const complete = await setLoginPasswords(
    async (text, params) => {
      statements.push(text);
      return { rows: params?.[0] === "qm_reader" ? [] : [{}] };
    },
    ["postgres://qm_app:one@db/qm", "postgres://qm_reader:two@db/qm", "postgres://postgres:three@db/qm", undefined],
  );
  assert.equal(complete, false);
  assert.equal(statements.filter((sql) => sql.startsWith("ALTER ROLE")).length, 1);
  assert.match(
    statements.find((sql) => sql.startsWith("ALTER ROLE"))!,
    /^ALTER ROLE qm_app PASSWORD 'SCRAM-SHA-256\$/,
  );
  assert.ok(statements.every((sql) => !sql.includes("one") && !sql.includes("two") && !sql.includes("three")));
});

test("setLoginPasswords leaves provider-managed logins alone when the owner may not alter them", async () => {
  const denied = Object.assign(new Error("MPG system roles cannot be modified"), { code: "42501" });
  assert.equal(
    await setLoginPasswords(
      async (text) => {
        if (text.startsWith("ALTER ROLE")) throw denied;
        return { rows: [{}] };
      },
      ["postgres://qm_app:one@db/qm"],
    ),
    true,
  );
  await assert.rejects(
    setLoginPasswords(
      async (text) => {
        if (text.startsWith("ALTER ROLE")) throw Object.assign(new Error("boom"), { code: "XX000" });
        return { rows: [{}] };
      },
      ["postgres://qm_app:one@db/qm"],
    ),
    /boom/,
  );
});

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
    await admin.query(
      `DO $$ BEGIN CREATE ROLE qm_app LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
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

test("instances booting together serialize their login password updates", { skip }, async () => {
  const pools = Array.from({ length: 8 }, () => new pg.Pool({ connectionString: URL!, max: 1 }));
  await pools[0]!.query(
    `DO $$ BEGIN CREATE ROLE qm_app LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  );
  try {
    for (let round = 0; round < 5; round++)
      await Promise.all(pools.map((pool) => setPoolLoginPasswords(pool, ["postgres://qm_app:same-password@db/qm"])));
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
});
