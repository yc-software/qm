import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";

const URL_ = process.env.DATABASE_URL;
const skip = URL_ ? false : "set DATABASE_URL (a Postgres) to run migration owner tests";

test(
  "a store on any URL migrates as the owner login, never as its own, and fails without an owner",
  { skip },
  async () => {
    const id = randomUUID().replaceAll("-", "");
    const schema = `mig_${id}`;
    const role = `nocreate_${id}`;
    const ownerUrl = new URL(URL_!);
    ownerUrl.searchParams.set("options", `-c search_path=${schema}`);
    const appUrl = new URL(ownerUrl);
    appUrl.username = role;
    appUrl.password = "app";
    const otherString = new URL(appUrl);
    otherString.searchParams.set("application_name", "elsewhere");
    const admin = new pg.Pool({ connectionString: ownerUrl.toString() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT ON TABLES TO ${role}`);
    const migration = (table: string) => ({
      id: `owner-test/${table}`,
      statements: [`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`],
    });
    try {
      configurePgPooling({ databaseUrl: appUrl.toString(), ownerUrl: ownerUrl.toString() });
      const store = createPgPool(otherString.toString(), [migration("routed")]);
      try {
        await store.q("INSERT INTO routed(id) VALUES ('a')");
        assert.deepEqual(await store.q("SELECT id FROM routed"), [{ id: "a" }]);
      } finally {
        await store.close();
      }
      const { rows } = await admin.query(
        `SELECT tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = 'routed'`,
        [schema],
      );
      assert.equal(rows[0]?.tableowner, new URL(URL_!).username || "postgres");
      const elsewhere = new URL(appUrl);
      elsewhere.searchParams.set("options", `-c search_path=${schema}_other`);
      await admin.query(`CREATE SCHEMA ${schema}_other`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema}_other TO ${role}`);
      const stray = createPgPool(elsewhere.toString(), [migration("stray")]);
      await stray.q("SELECT 1");
      await stray.close();
      const { rows: strayOwner } = await admin.query(
        `SELECT tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = 'stray'`,
        [`${schema}_other`],
      );
      assert.equal(strayOwner[0]?.tableowner, new URL(URL_!).username || "postgres");
      configurePgPooling({ databaseUrl: appUrl.toString() });
      const unowned = createPgPool(appUrl.toString(), [migration("unowned")]);
      await assert.rejects(unowned.q("SELECT 1"), /Schema migrations need DATABASE_OWNER_URL/);
      await unowned.close();
    } finally {
      configurePgPooling({});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema}_other CASCADE`);
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  },
);
