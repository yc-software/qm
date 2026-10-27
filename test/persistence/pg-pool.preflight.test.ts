import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { applyPgMigrations, definePgMigration, pgMigrationChecksum } from "../../src/persistence/pg-pool.ts";
import { MEMORY_FACTS_MIGRATIONS } from "../../src/memory/postgres-memory-service.ts";
import { CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import { withClient } from "../support/pg-client.ts";

// A refused migration run must leave the database exactly as it found it: no baseline adoption, no pending migration.

const base = process.env.DATABASE_URL!;
const created: string[] = [];

async function createDatabase(fixture?: string): Promise<string> {
  const name = `qm_preflight_${randomBytes(6).toString("hex")}`;
  await withClient(base, (client) => client.query(`CREATE DATABASE ${name}`));
  created.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (fixture) {
    const sql = gunzipSync(readFileSync(new URL(`../fixtures/schema-baseline/${fixture}`, import.meta.url))).toString();
    await withClient(url.toString(), (client) => client.query(sql));
  }
  return url.toString();
}

async function withPool<T>(url: string, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const ledger = (pool: pg.Pool) =>
  pool
    .query<{ id: string; checksum: string }>("SELECT id, checksum FROM qm_schema_migrations ORDER BY id")
    .then((r) => r.rows);
const relation = (pool: pg.Pool, name: string) =>
  pool.query<{ r: string | null }>("SELECT to_regclass($1)::text AS r", [name]).then((r) => r.rows[0]!.r);

after(async () => {
  for (const name of created) {
    await withClient(base, (client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }
});

test("a checksum mismatch refuses the run before any pending migration applies", async () => {
  const url = await createDatabase();
  await withPool(url, async (pool) => {
    await applyPgMigrations(pool, [definePgMigration("test/preflight-a", ["CREATE TABLE preflight_a(x int)"])]);
    const before = await ledger(pool);
    await assert.rejects(
      applyPgMigrations(pool, [
        // Sorts first, so a run that checked as it went would apply it before reaching the mismatch.
        definePgMigration("test/preflight-0-pending", ["CREATE TABLE preflight_pending(x int)"]),
        definePgMigration("test/preflight-a", ["CREATE TABLE preflight_a(x int, y int)"]),
      ]),
      /nothing was applied: migration test\/preflight-a checksum mismatch/,
    );
    assert.deepEqual(await ledger(pool), before);
    assert.equal(await relation(pool, "preflight_pending"), null);
  });
});

test("a checksum mismatch refuses before the baseline is adopted", async () => {
  const url = await createDatabase("main-9be16d35.sql.gz");
  await withPool(url, async (pool) => {
    await pool.query(
      "INSERT INTO qm_schema_migrations(id, checksum) VALUES ('test/preflight-a', 'released-elsewhere')",
    );
    const before = await ledger(pool);
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration("test/preflight-0-pending", ["CREATE TABLE preflight_pending(x int)"]),
        definePgMigration("test/preflight-a", ["CREATE TABLE preflight_a(x int)"]),
      ]),
      /checksum mismatch \(database=released-elsewhere/,
    );
    assert.deepEqual(await ledger(pool), before);
    assert.ok(!before.some((row) => row.id === "baseline/0001"));
    assert.equal(await relation(pool, "preflight_pending"), null);
  });
});

test("an id defined twice with different statements refuses the run", async () => {
  const url = await createDatabase();
  await withPool(url, async (pool) => {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration("test/preflight-twin", ["CREATE TABLE preflight_twin(x int)"]),
        definePgMigration("test/preflight-twin", ["CREATE TABLE preflight_twin(y int)"]),
      ]),
      /test\/preflight-twin is defined twice/,
    );
    assert.equal(await relation(pool, "qm_schema_migrations"), null);
  });
});

test("memory text_hash: a database that ran the first release of 0002 reaches NOT NULL through 0003", async () => {
  const url = await createDatabase();
  const migrations = MEMORY_FACTS_MIGRATIONS.map((m) =>
    definePgMigration(m.id, m.statements, m.expectedChecksum, m.acceptedChecksums),
  );
  const current = migrations.find((m) => m.id === "memory/facts/0002-text-hash")!;
  // memory/facts/0002-text-hash as the StyleUp line first released it (batch 17), which StyleUp databases recorded.
  const firstRelease = [
    "ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS text_hash TEXT",
    `CREATE OR REPLACE FUNCTION memory_facts_text_hash() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         NEW.text_hash := encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex');
         RETURN NEW;
       END $$`,
    "DROP TRIGGER IF EXISTS memory_facts_text_hash ON memory_facts",
    `CREATE TRIGGER memory_facts_text_hash BEFORE INSERT OR UPDATE OF text ON memory_facts
       FOR EACH ROW EXECUTE FUNCTION memory_facts_text_hash()`,
    "UPDATE memory_facts SET text_hash = encode(sha256(convert_to(text, 'UTF8')), 'hex') WHERE text_hash IS NULL",
  ];
  assert.equal(pgMigrationChecksum(firstRelease), current.acceptedChecksums![0]);
  await withPool(url, async (pool) => {
    await applyPgMigrations(pool, []);
    await pool.query(
      "INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at) VALUES ('s', 'old', 'unknown', true, 1, 1)",
    );
    for (const statement of firstRelease) await pool.query(statement);
    await pool.query("INSERT INTO qm_schema_migrations(id, checksum) VALUES ($1, $2)", [
      current.id,
      current.acceptedChecksums![0],
    ]);
    await pool.query("ALTER TABLE memory_facts DISABLE TRIGGER memory_facts_text_hash");
    await pool.query(
      "INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at) VALUES ('s', 'unhashed', 'unknown', true, 1, 1)",
    );
    await pool.query("ALTER TABLE memory_facts ENABLE TRIGGER memory_facts_text_hash");

    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      assert.equal(await applyPgMigrations(pool, migrations), 2);
    } finally {
      console.log = log;
    }
    const recorded = (await ledger(pool)).length - 2;
    assert.deepEqual(
      logged.filter((line) => line.startsWith("[pg] migration preflight ok")),
      [
        `[pg] migration preflight ok: 2 pending (${recorded} recorded); baseline already recorded; accepted an earlier checksum for memory/facts/0002-text-hash`,
      ],
    );
    const rows = await ledger(pool);
    assert.equal(rows.find((r) => r.id === current.id)?.checksum, current.acceptedChecksums![0]);
    assert.ok(rows.some((r) => r.id === "memory/facts/0003-text-hash-not-null"));
    const body = await pool.query("SELECT prosrc FROM pg_proc WHERE proname = 'memory_facts_text_hash'");
    assert.match(body.rows[0].prosrc, /^\n {6}BEGIN\n {8}NEW\.text_hash/);
    const column = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'memory_facts' AND column_name = 'text_hash'",
    );
    assert.equal(column.rows[0].is_nullable, "NO");
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM memory_facts WHERE text_hash IS NULL")).rows[0].n,
      0,
    );
  });
});

test("memory text_hash: a fresh database and a database on the current 0002 both end NOT NULL", async () => {
  const url = await createDatabase();
  const migrations = MEMORY_FACTS_MIGRATIONS.map((m) =>
    definePgMigration(m.id, m.statements, m.expectedChecksum, m.acceptedChecksums),
  );
  await withPool(url, async (pool) => {
    await applyPgMigrations(
      pool,
      migrations.filter((m) => m.id !== "memory/facts/0003-text-hash-not-null"),
    );
    const column = () =>
      pool
        .query(
          "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'memory_facts' AND column_name = 'text_hash'",
        )
        .then((r) => r.rows[0].is_nullable);
    assert.equal(await column(), "NO");
    assert.equal(await applyPgMigrations(pool, migrations), 1);
    assert.equal(await applyPgMigrations(pool, migrations), 0);
    assert.equal(await column(), "NO");
  });
});

test("a concurrent index build leaves the schema lock free for other migration runs", async () => {
  const url = await createDatabase();
  await withPool(url, async (pool) => {
    await applyPgMigrations(pool, [definePgMigration("test/cic-table", ["CREATE TABLE cic_target(x int)"])]);
    const holder = await pool.connect();
    try {
      // An open writer makes CREATE INDEX CONCURRENTLY wait, which keeps the build in flight.
      await holder.query("BEGIN");
      await holder.query("INSERT INTO cic_target VALUES (1)");
      const build = applyPgMigrations(pool, [
        definePgMigration("test/cic-table", ["CREATE TABLE cic_target(x int)"]),
        definePgMigration("test/cic-index", ["CREATE INDEX CONCURRENTLY IF NOT EXISTS cic_target_x ON cic_target(x)"]),
      ]);
      const waiting = async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'CREATE INDEX CONCURRENTLY%' AND wait_event_type = 'Lock'",
          )
        ).rows[0].n;
      for (let i = 0; i < 100 && (await waiting()) === 0; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(await waiting(), 1);
      const probe = await pool.connect();
      try {
        const locked = await probe.query("SELECT pg_try_advisory_lock(hashtext('qm:schema-migrations')) AS ok");
        assert.equal(locked.rows[0].ok, true);
        await probe.query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))");
      } finally {
        probe.release();
      }
      await holder.query("COMMIT");
      assert.equal(await build, 1);
    } finally {
      holder.release();
    }
    assert.ok((await ledger(pool)).some((row) => row.id === "test/cic-index"));
    assert.equal(await relation(pool, "cic_target_x"), "cic_target_x");
  });
});

test("contract migrations are idempotent, before and after the drops they hold back", async () => {
  const url = await createDatabase();
  const contract = CONTRACT_MIGRATIONS.map((m) => definePgMigration(m.id, m.statements));
  await withPool(url, async (pool) => {
    await applyPgMigrations(pool, []);
    for (const migration of contract) {
      for (let run = 0; run < 2; run++) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const statement of migration.statements) await client.query(statement);
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      }
    }
    assert.equal(await relation(pool, "deliveries"), null);
    assert.equal(await relation(pool, "swarms"), null);
  });
});
