import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pool } from "pg";
import { mergeDirs, runMigration } from "../scripts/migrate-principals-to-email.mjs";

const BASE_URL = process.env.DATABASE_URL;
const skip = BASE_URL ? false : "set DATABASE_URL (a Postgres) to run the migration tests";

const MAPPING = { U9MIGA: "alice@x.com", U9MIGB: "bob@x.com" };
const silent = () => {};

let testUrl = "";
let pool: Pool | null = null;

before(async () => {
  if (!BASE_URL) return;
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: BASE_URL });
  await admin.query("DROP DATABASE IF EXISTS qm_migtest WITH (FORCE)");
  await admin.query("CREATE DATABASE qm_migtest");
  await admin.end();
  const url = new URL(BASE_URL);
  url.pathname = "/qm_migtest";
  testUrl = url.toString();
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

test("mergeDirs moves new entries, recurses, never overwrites, and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "mergedirs-"));
  const src = join(root, "src");
  const dst = join(root, "dst");
  mkdirSync(join(src, "sub"), { recursive: true });
  mkdirSync(join(dst, "sub"), { recursive: true });
  writeFileSync(join(src, "a.txt"), "A");
  writeFileSync(join(src, "sub", "b.txt"), "B");
  writeFileSync(join(src, "sub", "c.txt"), "src C");
  writeFileSync(join(dst, "sub", "c.txt"), "dst C");

  const conflicts = mergeDirs(src, dst);
  assert.deepEqual(conflicts, [join("sub", "c.txt")]);
  assert.equal(readFileSync(join(dst, "a.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(dst, "sub", "b.txt"), "utf8"), "B");
  assert.equal(readFileSync(join(dst, "sub", "c.txt"), "utf8"), "dst C", "existing data is never overwritten");
  assert.equal(readFileSync(join(src, "sub", "c.txt"), "utf8"), "src C", "conflicting entry stays behind in src");

  assert.deepEqual(mergeDirs(src, dst), [join("sub", "c.txt")], "re-merge reports the same conflict");

  rmSync(join(src, "sub", "c.txt"));
  assert.deepEqual(mergeDirs(src, dst), []);
  assert.ok(!existsSync(src), "src is removed once emptied");
});

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

test("workspace dirs: rename when free, merge without overwrite when the email dir exists", { skip }, async () => {
  await reset();
  const dataDir = mkdtempSync(join(tmpdir(), "migtest-"));
  const ws = join(dataDir, "workspaces");
  mkdirSync(join(ws, "personal__U9MIGA"), { recursive: true });
  writeFileSync(join(ws, "personal__U9MIGA", "fresh.md"), "from old");
  writeFileSync(join(ws, "personal__U9MIGA", "clash.md"), "old version");
  mkdirSync(join(ws, "personal__alice__x.com"), { recursive: true });
  writeFileSync(join(ws, "personal__alice__x.com", "clash.md"), "new version");
  mkdirSync(join(ws, "personal__U9MIGB"), { recursive: true });
  writeFileSync(join(ws, "personal__U9MIGB", "note.md"), "bob");

  const { problems } = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, dataDir, log: silent });

  assert.equal(readFileSync(join(ws, "personal__bob__x.com", "note.md"), "utf8"), "bob");
  assert.ok(!existsSync(join(ws, "personal__U9MIGB")), "unobstructed dir is renamed away");
  assert.equal(
    readFileSync(join(ws, "personal__alice__x.com", "clash.md"), "utf8"),
    "new version",
    "existing data is never overwritten",
  );
  assert.equal(
    readFileSync(join(ws, "personal__alice__x.com", "fresh.md"), "utf8"),
    "from old",
    "non-conflicting entries are merged in",
  );
  assert.equal(
    readFileSync(join(ws, "personal__U9MIGA", "clash.md"), "utf8"),
    "old version",
    "conflicting entry stays in the old dir",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /clash\.md/);

  const second = await runMigration({ pool: pool!, mapping: MAPPING, apply: true, dataDir, log: silent });
  assert.equal(second.problems.length, 1, "a re-run reports the same conflict instead of throwing");
});
