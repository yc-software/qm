import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the base schema tests";

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `base_schema_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

async function migrate(url: string): Promise<void> {
  createPostgresSessionStore(url);
  const runs = createPostgresRunStore(url);
  try {
    await migrateRegisteredPgSchemas(url);
  } finally {
    await runs.close();
  }
}

const present = async (admin: pg.Pool, sql: string) => (await admin.query(`SELECT ${sql} AS v`)).rows[0].v as unknown;

test("a fresh database gets the base schema without items.target_seq", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await migrate(url);
    assert.equal(await present(admin, "to_regclass('items') IS NOT NULL"), true);
    assert.equal(await present(admin, "to_regclass('runs') IS NOT NULL"), true);
    const column = await admin.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'target_seq'",
    );
    assert.equal(column.rowCount, 0);
  });
});

test("a fully migrated database skips the base schema and drops only the retired objects", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await admin.query(`CREATE TABLE qm_schema_migrations(
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await admin.query(`INSERT INTO qm_schema_migrations(id, checksum) VALUES
      ('sessions/store/0046-spend-days-cron-rebuild', 'x'), ('runs/store/0010-drop-turn-metrics', 'x')`);
    await admin.query("CREATE TABLE sessions(id TEXT PRIMARY KEY)");
    await admin.query("CREATE TABLE runs(id TEXT PRIMARY KEY)");
    await admin.query(`CREATE TABLE items(seq BIGINT, kind TEXT, target_seq BIGINT,
      CONSTRAINT items_target_seq_kind CHECK (target_seq IS NULL OR kind = 'Retraction'))`);
    await admin.query("CREATE TABLE tool_calls(run_id TEXT)");
    await admin.query("CREATE FUNCTION safe_json(t text) RETURNS json LANGUAGE sql AS 'SELECT t::json'");
    await migrate(url);
    const columns = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'items' ORDER BY ordinal_position",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["seq", "kind", "target_seq"],
    );
    assert.equal(await present(admin, "to_regclass('blobs') IS NULL"), true);
    assert.equal(await present(admin, "to_regclass('tool_calls') IS NULL"), true);
    assert.equal(await present(admin, "to_regprocedure('safe_json(text)') IS NULL"), true);
  });
});

for (const table of ["sessions", "runs"]) {
  test(`a database with ${table} from an older release is refused instead of half-upgraded`, { skip }, async () => {
    await withDatabase(async (url, admin) => {
      await admin.query(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`);
      await assert.rejects(migrate(url), /predates the base schema/);
      assert.equal(await present(admin, "to_regclass('items') IS NULL"), true);
    });
  });
}
