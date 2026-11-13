import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { migrateRegisteredPgSchemas, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the base schema tests";

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const url = testBareDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url });
  try {
    await run(url, admin);
  } finally {
    await admin.end();
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

async function markTenancyApplied(url: string, admin: pg.Pool): Promise<void> {
  createPostgresSessionStore(url);
  await createPostgresRunStore(url).close();
  const tenancy = registeredPgMigrations(url).filter((m) => /-tenant|claim/.test(m.id));
  await admin.query("INSERT INTO qm_schema_migrations(id, checksum) SELECT * FROM unnest($1::text[], $2::text[])", [
    tenancy.map((m) => m.id),
    tenancy.map((m) => m.checksum),
  ]);
}

const present = async (admin: pg.Pool, sql: string) => (await admin.query(`SELECT ${sql} AS v`)).rows[0].v as unknown;

test("a fresh database gets the base schema without items.target_seq or session_leases", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await migrate(url);
    assert.equal(await present(admin, "to_regclass('items') IS NOT NULL"), true);
    assert.equal(await present(admin, "to_regclass('runs') IS NOT NULL"), true);
    const column = await admin.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'target_seq'",
    );
    assert.equal(column.rowCount, 0);
    assert.equal(await present(admin, "to_regclass('session_leases') IS NULL"), true);
    assert.equal(
      await present(admin, "pg_get_indexdef('session_llm_requests_session_spend_recovery'::regclass)"),
      "CREATE INDEX session_llm_requests_session_spend_recovery ON public.session_llm_requests USING btree (session_id, created_at) WHERE (usage_json IS NOT NULL)",
    );
  });
});

test("a fully migrated database skips the base schema and drops the retired objects", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await admin.query(`CREATE TABLE qm_schema_migrations(
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await admin.query(`INSERT INTO qm_schema_migrations(id, checksum) VALUES
      ('sessions/store/0046-spend-days-cron-rebuild', 'x'), ('runs/store/0010-drop-turn-metrics', 'x'),
      ('directory/store/0005', 'x')`);
    await admin.query("CREATE TABLE directory_sync(org_id TEXT PRIMARY KEY, channel_members_synced BOOLEAN)");
    await admin.query("CREATE TABLE sessions(id TEXT PRIMARY KEY, thread_ref TEXT, spawn_meta TEXT)");
    await admin.query(
      "CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT, status TEXT, request TEXT, result TEXT, created_at BIGINT, seq BIGINT, preemptions INT NOT NULL DEFAULT 0)",
    );
    await admin.query("CREATE EXTENSION IF NOT EXISTS btree_gin");
    await admin.query(`CREATE TABLE items(seq BIGINT, tenant_id TEXT, session_id TEXT, kind TEXT, variant TEXT,
      text TEXT, search TSVECTOR, target_seq BIGINT, author TEXT, body JSONB, created_at TIMESTAMPTZ, hidden BOOLEAN,
      CONSTRAINT items_target_seq_kind CHECK (target_seq IS NULL OR kind = 'Retraction'))`);
    await admin.query(
      "CREATE FUNCTION forbid_direct_delete() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN OLD; END'",
    );
    await admin.query(
      "CREATE TRIGGER items_delete_through_session BEFORE DELETE ON items FOR EACH ROW EXECUTE FUNCTION forbid_direct_delete()",
    );
    await admin.query("CREATE TABLE tool_calls(run_id TEXT)");
    await admin.query(
      "CREATE TABLE session_leases(session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL)",
    );
    await admin.query("CREATE TABLE session_llm_requests(session_id TEXT, created_at BIGINT, usage_json TEXT)");
    await admin.query(`CREATE INDEX session_llm_requests_session_spend_recovery
      ON session_llm_requests(session_id, created_at) WHERE usage_json IS NOT NULL`);
    await admin.query("CREATE TABLE qm_tenant(id UUID PRIMARY KEY)");
    await admin.query("CREATE FUNCTION safe_json(t text) RETURNS json LANGUAGE sql AS 'SELECT t::json'");
    await admin.query(`CREATE TABLE participants(session_id TEXT, principal_id TEXT, valid_from BIGINT NOT NULL,
      valid_to BIGINT, valid_from_seq INT, valid_to_seq INT)`);
    await admin.query(
      `INSERT INTO participants VALUES ('s1', 'member', 5, NULL, 3, NULL), ('s1', 'removed', 5, 9, 3, 7)`,
    );
    await markTenancyApplied(url, admin);
    await migrate(url);
    assert.deepEqual(
      (await admin.query("SELECT principal_id FROM participants")).rows.map((row) => row.principal_id),
      ["member"],
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'participants' ORDER BY ordinal_position",
        )
      ).rows.map((row) => row.column_name),
      ["session_id", "principal_id"],
    );
    const columns = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'items' ORDER BY ordinal_position",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["seq", "tenant_id", "session_id", "kind", "variant", "text", "search", "author", "body", "created_at", "hidden"],
    );
    assert.equal(await present(admin, "to_regclass('blobs') IS NULL"), true);
    assert.equal(await present(admin, "to_regclass('tool_calls') IS NULL"), true);
    assert.equal(await present(admin, "to_regclass('session_leases') IS NULL"), true);
    assert.equal(await present(admin, "to_regprocedure('safe_json(text)') IS NULL"), true);
    assert.equal(
      await present(
        admin,
        "EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = 'sessions/store/0051-spend-recovery-index')",
      ),
      true,
    );
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
