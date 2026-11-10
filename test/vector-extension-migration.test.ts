import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { VECTOR_MIGRATIONS } from "../src/memory/postgres-vector-store.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the vector extension tests";
const OWNER = "qm_vector_owner";
const extension = VECTOR_MIGRATIONS.filter((m) => m.id.endsWith("-vector-extension")).map(definePgMigration);

async function ownedBy(databaseUrl: string, preinstall: boolean): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(
      `DO $r$ BEGIN CREATE ROLE ${OWNER} NOSUPERUSER; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`,
    );
    await admin.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
    if (preinstall) await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await admin.end();
  }
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${OWNER}`);
  return new pg.Pool({ connectionString: url.toString(), max: 1 });
}

test("a non-superuser owner proceeds when pgvector is already installed", { skip }, async () => {
  const pool = await ownedBy(testBareDatabaseUrl(), true);
  try {
    await applyPgMigrations(pool, extension);
    assert.equal((await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).rowCount, 1);
  } finally {
    await pool.end();
  }
});

test("a non-superuser owner without pgvector surfaces the real error", { skip }, async () => {
  const pool = await ownedBy(testBareDatabaseUrl(), false);
  try {
    await assert.rejects(applyPgMigrations(pool, extension), /permission denied to create extension "vector"/);
  } finally {
    await pool.end();
  }
});
