import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { runMigration } from "../scripts/migrate-principals-to-email.mjs";
import { testDatabaseUrl } from "./support/test-database.ts";

const BASE_URL = process.env.DATABASE_URL;
const skip = BASE_URL ? false : "set DATABASE_URL (a Postgres) to run the migration tests";

const MAPPING = { U9MIGA: "alice@x.com", U9MIGB: "bob@x.com" };
const silent = () => {};

let testUrl = "";
let pool: Pool | null = null;

before(async () => {
  if (!BASE_URL) return;
  const pg = (await import("pg")).default;
  testUrl = testDatabaseUrl();
  pool = new pg.Pool({ connectionString: testUrl });
  await pool.query(`
    CREATE TABLE participants(session_id TEXT NOT NULL, principal_id TEXT NOT NULL, PRIMARY KEY(session_id, principal_id));
    CREATE TABLE migtest_kv(id TEXT PRIMARY KEY, json JSONB);
  `);
});

after(async () => {
  await pool?.end();
});

async function reset(): Promise<void> {
  await pool!.query("TRUNCATE participants, migtest_kv");
}

async function kvById(): Promise<Map<string, unknown>> {
  const { rows } = await pool!.query("SELECT id, json FROM migtest_kv");
  return new Map(rows.map((r) => [r.id as string, r.json as unknown]));
}

test("dry run reports but writes nothing", { skip }, async () => {
  await reset();
  await pool!.query("INSERT INTO participants VALUES ('s1','U9MIGA')");
  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: false, log: silent });
  assert.deepEqual(problems, []);
  const { rows } = await pool!.query("SELECT principal_id FROM participants");
  assert.equal(rows[0]!.principal_id, "U9MIGA");
});

test("re-keys relational columns and kv rows (id + json payload)", { skip }, async () => {
  await reset();
  await pool!.query("INSERT INTO participants VALUES ('s1','U9MIGA'), ('s1','U9OTHER')");
  await pool!.query(`INSERT INTO migtest_kv VALUES ('personal:U9MIGA', '{"owner":"personal:U9MIGA"}')`);
  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, log: silent });
  assert.deepEqual(problems, []);
  const ids = (await pool!.query("SELECT principal_id FROM participants")).rows.map((r) => r.principal_id).sort();
  assert.deepEqual(ids, ["U9OTHER", "alice@x.com"]);
  const kv = await kvById();
  assert.equal(kv.size, 1);
  assert.deepEqual(kv.get("personal:alice@x.com"), { owner: "personal:alice@x.com" });
});

test("relational re-key deletes the old row when the email row already exists (PK collision)", { skip }, async () => {
  await reset();
  await pool!.query("INSERT INTO participants VALUES ('s1','U9MIGA'), ('s1','alice@x.com')");
  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, log: silent });
  assert.deepEqual(problems, []);
  const { rows } = await pool!.query("SELECT principal_id FROM participants");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.principal_id, "alice@x.com");
});

test("kv re-key never clobbers different data already under the email id", { skip }, async () => {
  await reset();
  await pool!.query(
    `INSERT INTO migtest_kv VALUES ('personal:U9MIGA', '{"note":"old"}'), ('personal:alice@x.com', '{"note":"newer"}')`,
  );
  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, log: silent });
  const kv = await kvById();
  assert.deepEqual(kv.get("personal:alice@x.com"), { note: "newer" }, "the newer email row is preserved");
  assert.deepEqual(kv.get("personal:U9MIGA"), { note: "old" }, "the old row is kept for manual merge, not dropped");
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /migtest_kv/);
  assert.match(problems[0]!, /merge manually/);
});

test("kv re-run after a crash between insert and delete cleans up the redundant old row", { skip }, async () => {
  await reset();
  await pool!.query(
    `INSERT INTO migtest_kv VALUES ('personal:U9MIGA', '{"n":1}'), ('personal:alice@x.com', '{"n":1}')`,
  );
  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, log: silent });
  assert.deepEqual(problems, []);
  const kv = await kvById();
  assert.equal(kv.size, 1);
  assert.deepEqual(kv.get("personal:alice@x.com"), { n: 1 });
});

test("kv pass streams in batches — rows beyond one batch are all re-keyed", { skip }, async () => {
  await reset();
  const values = Array.from({ length: 250 }, (_, i) => `('item:${i}:U9MIGA', '{"i":${i}}')`).join(",");
  await pool!.query(`INSERT INTO migtest_kv VALUES ${values}`);
  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, log: silent });
  assert.deepEqual(problems, []);
  const { rows } = await pool!.query("SELECT count(*)::int AS n FROM migtest_kv WHERE id LIKE '%:U9MIGA'");
  assert.equal(rows[0]!.n, 0);
  const moved = await pool!.query("SELECT count(*)::int AS n FROM migtest_kv WHERE id LIKE 'item:%:alice@x.com'");
  assert.equal(moved.rows[0]!.n, 250);
});

test("apply refuses while another client is connected; dry run only warns", { skip }, async () => {
  await reset();
  const pg = (await import("pg")).default;
  const other = new pg.Pool({ connectionString: testUrl });
  const held = await other.connect();
  try {
    await assert.rejects(runMigration({ pool: pool!, mapping: MAPPING, apply: true, log: silent }), /other client/);
    await assert.doesNotReject(runMigration({ pool: pool!, mapping: MAPPING, apply: false, log: silent }));
    const { problems } = await runMigration({
      pool: pool!,
      mapping: MAPPING,
      apply: true,
      allowLive: true,
      log: silent,
    });
    assert.deepEqual(problems, []);
  } finally {
    held.release();
    await other.end();
  }
});
