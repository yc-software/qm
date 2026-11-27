import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  applyPgMigrations,
  createPgPool,
  definePgMigration,
  migrateDatabase,
  PG_MIGRATIONS_TABLE,
} from "../src/persistence/pg-pool.ts";
import { settle } from "./support/settle.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

function names(): { id: string; table: string } {
  const suffix = randomUUID().replaceAll("-", "");
  return { id: `test/integration/${suffix}/0001`, table: `migration_test_${suffix}` };
}

test("concurrent index migrations adopt prebuilt indexes and serialize retries", { skip }, async () => {
  const a = new pg.Pool({ connectionString: databaseUrl });
  const b = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const index = `${table}_idx`;
  const migration = definePgMigration({
    id,
    statements: [`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${table}(value)`],
  });
  try {
    await a.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
    await a.query(`CREATE INDEX CONCURRENTLY ${index} ON ${table}(value)`);
    const original = await a.query("SELECT to_regclass($1)::oid AS oid", [index]);
    await Promise.all([applyPgMigrations(a, [migration]), applyPgMigrations(b, [migration])]);
    const adopted = await a.query("SELECT to_regclass($1)::oid AS oid", [index]);
    assert.deepEqual(adopted.rows, original.rows);
    const ledger = await a.query(`SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    assert.deepEqual(ledger.rows, [{ checksum: migration.checksum }]);
  } finally {
    await a.query(`DROP TABLE IF EXISTS ${table}`);
    await a.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await Promise.all([a.end(), b.end()]);
  }
});

test("failed concurrent index builds are unrecorded and rebuild invalid indexes on retry", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const index = `${table}_idx`;
  const migration = definePgMigration({
    id,
    statements: [`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${table}(value)`],
  });
  try {
    await pool.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
    await pool.query(`INSERT INTO ${table} VALUES (1), (1)`);
    await assert.rejects(applyPgMigrations(pool, [migration]), /could not create unique index/);
    const failed = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)", [index]);
    assert.deepEqual(failed.rows, [{ indisvalid: false }]);
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id])).rowCount, 0);
    await pool.query(`DELETE FROM ${table}`);
    await pool.query(`INSERT INTO ${table} VALUES (1), (2)`);
    await applyPgMigrations(pool, [migration]);
    const repaired = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)", [index]);
    assert.deepEqual(repaired.rows, [{ indisvalid: true }]);
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id])).rowCount, 1);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

test("concurrent index migrations reject mixed transactional statements before execution", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration({
          id,
          statements: [
            `CREATE TABLE ${table}(value INT)`,
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_idx ON ${table}(value)`,
          ],
        }),
      ]),
      /must contain only concurrent indexes/,
    );
    assert.equal((await pool.query("SELECT to_regclass($1) AS name", [table])).rows[0].name, null);
  } finally {
    await pool.end();
  }
});

test("concurrent index retry resolves indexes in the target table schema", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const schema = `s_${table}`;
  const index = `${table}_idx`;
  const migration = definePgMigration({
    id,
    statements: [`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${schema}.events(value)`],
  });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.events(value INT)`);
    await pool.query(`CREATE TABLE ${table}(value INT)`);
    await pool.query(`CREATE INDEX ${index} ON ${table}(value)`);
    const original = await pool.query("SELECT to_regclass($1)::oid AS oid", [index]);
    await pool.query(`INSERT INTO ${schema}.events VALUES (1), (1)`);
    await assert.rejects(applyPgMigrations(pool, [migration]), /could not create unique index/);
    await pool.query(`DELETE FROM ${schema}.events`);
    await applyPgMigrations(pool, [migration]);
    assert.deepEqual((await pool.query("SELECT to_regclass($1)::oid AS oid", [index])).rows, original.rows);
    const repaired = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)", [
      `${schema}.${index}`,
    ]);
    assert.deepEqual(repaired.rows, [{ indisvalid: true }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id]);
    await pool.end();
  }
});

test("concurrent migrators apply one version exactly once", { skip }, async () => {
  const a = new pg.Pool({ connectionString: databaseUrl });
  const b = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const migration = definePgMigration({
    id,
    statements: [`CREATE TABLE ${table}(value INT NOT NULL)`, `INSERT INTO ${table}(value) VALUES (1)`],
  });
  try {
    await Promise.all([applyPgMigrations(a, [migration]), applyPgMigrations(b, [migration])]);
    const rows = await a.query(`SELECT value FROM ${table}`);
    assert.deepEqual(rows.rows, [{ value: 1 }]);
    const applied = await a.query(`SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    assert.equal(applied.rows[0]?.checksum, migration.checksum);
  } finally {
    await a.query(`DROP TABLE IF EXISTS ${table}`);
    await a.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await Promise.all([a.end(), b.end()]);
  }
});

test("an applied migration rejects checksum drift", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await applyPgMigrations(pool, [
      definePgMigration({ id, statements: [`CREATE TABLE ${table}(value INT NOT NULL)`] }),
    ]);
    await assert.rejects(
      applyPgMigrations(pool, [definePgMigration({ id, statements: [`CREATE TABLE ${table}(value TEXT NOT NULL)`] })]),
      /checksum mismatch/,
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

test("a failed migration rolls back and is not recorded", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration({
          id,
          statements: [`CREATE TABLE ${table}(value INT NOT NULL)`, `INSERT INTO missing_${table} VALUES (1)`],
        }),
      ]),
    );
    const tableState = await pool.query("SELECT to_regclass($1) AS name", [table]);
    assert.equal(tableState.rows[0]?.name, null);
    const applied = await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    assert.equal(applied.rowCount, 0);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

for (const lock of ["qm:schema-migrations"]) {
  test(`waiting for the ${lock} lock does not deadlock a concurrent index build`, { skip }, async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const holder = new pg.Client({ connectionString: databaseUrl });
    const { id, table } = names();
    const store = createPgPool(databaseUrl!);
    await holder.connect();
    try {
      await admin.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
      await admin.query(`INSERT INTO ${table}(value) VALUES (1)`);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
      const ready = migrateDatabase(databaseUrl!);
      let startFailure: unknown;
      ready.catch((error: unknown) => {
        startFailure = error;
      });
      let waiting = 0;
      await settle(async () => {
        const waiters = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid NOT IN (pg_backend_pid(), $1) AND query LIKE '%advisory_lock(hashtext(%'",
          [holderPid],
        );
        waiting = waiters.rowCount ?? 0;
        return waiting > 0;
      });
      assert.ok(
        waiting,
        `the store never waited for the schema lock${startFailure ? `: ${String(startFailure)}` : ""}`,
      );
      try {
        await holder.query(`CREATE INDEX CONCURRENTLY ${table}_idx ON ${table}(value)`);
      } finally {
        await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
      }
      await ready;
      assert.deepEqual(await store.q(`SELECT value FROM ${table}`), [{ value: 1 }]);
    } finally {
      await holder.end();
      await store.close();
      await admin.query(`DROP TABLE IF EXISTS ${table}`);
      await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
      await admin.end();
    }
  });
}

test("a migration recorded by an earlier step's SQL in the same run is not applied again", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const sibling = definePgMigration({ id: `${id}/b`, statements: [`INSERT INTO ${table}(value) VALUES (2)`] });
  const recorder = definePgMigration({
    id: `${id}/a`,
    statements: [
      `CREATE TABLE ${table}(value INT)`,
      `INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ('${sibling.id}', '${sibling.checksum}')`,
    ],
  });
  try {
    await applyPgMigrations(pool, [recorder, sibling]);
    assert.deepEqual((await pool.query(`SELECT value FROM ${table}`)).rows, []);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id LIKE $1`, [`${id}/%`]);
    await pool.end();
  }
});

test(
  "a migration that replaces earlier ones is recorded without running once all of them are applied",
  { skip },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const { id, table } = names();
    const created = definePgMigration({ id: `${id}/a`, statements: [`CREATE TABLE ${table}(value INT)`] });
    const filled = definePgMigration({ id: `${id}/b`, statements: [`INSERT INTO ${table}(value) VALUES (1)`] });
    const baseline = definePgMigration({
      id: `${id}/baseline`,
      statements: [`CREATE TABLE ${table}(value INT)`],
      replaces: [created.id, filled.id],
    });
    try {
      await applyPgMigrations(pool, [created]);
      await assert.rejects(applyPgMigrations(pool, [baseline]), /missing 1 of them \(.*\/b\)/);
      await applyPgMigrations(pool, [filled, baseline]);
      assert.deepEqual((await pool.query(`SELECT value FROM ${table}`)).rows, [{ value: 1 }]);
      const ledger = await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [baseline.id]);
      assert.equal(ledger.rowCount, 1);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id LIKE $1`, [`${id}/%`]);
      await pool.end();
    }
  },
);

test(
  "a batched migration commits each batch, resumes after a failure and is recorded once done",
  { skip },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const { id, table } = names();
    const migration = definePgMigration({
      id,
      statements: [
        `-- qm:batched
       UPDATE ${table} SET done = true WHERE value IN (SELECT value FROM ${table} WHERE NOT done ORDER BY value LIMIT 2);
       SELECT EXISTS (SELECT 1 FROM ${table} WHERE NOT done) AS more`,
      ],
    });
    try {
      await pool.query(`CREATE TABLE ${table}(value INT PRIMARY KEY, done BOOLEAN NOT NULL DEFAULT false)`);
      await pool.query(`INSERT INTO ${table}(value) SELECT generate_series(1, 7)`);
      await pool.query(`CREATE FUNCTION ${table}_stop() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.value = 6 THEN RAISE EXCEPTION 'stopped at 6'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER stop BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_stop()`);
      await assert.rejects(applyPgMigrations(pool, [migration]), /stopped at 6/);
      const partial = await pool.query(`SELECT value FROM ${table} WHERE done ORDER BY value`);
      assert.deepEqual(
        partial.rows.map((row: { value: number }) => row.value),
        [1, 2, 3, 4],
      );
      assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id])).rowCount, 0);
      await pool.query(`DROP TRIGGER stop ON ${table}`);
      await applyPgMigrations(pool, [migration]);
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE NOT done`)).rowCount, 0);
      assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id])).rowCount, 1);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query(`DROP FUNCTION IF EXISTS ${table}_stop()`);
      await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
      await pool.end();
    }
  },
);

test("a batched migration waits out a row lock by retrying instead of queueing behind it", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const holder = await pool.connect();
  const { id, table } = names();
  const migration = definePgMigration({
    id,
    statements: [
      `-- qm:batched
       UPDATE ${table} SET done = true WHERE NOT done;
       SELECT false AS more`,
    ],
  });
  try {
    await pool.query(`CREATE TABLE ${table}(value INT PRIMARY KEY, done BOOLEAN NOT NULL DEFAULT false)`);
    await pool.query(`INSERT INTO ${table}(value) VALUES (1)`);
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM ${table} FOR UPDATE`);
    const applied = applyPgMigrations(pool, [migration]);
    const waits = async (): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
          [`%UPDATE ${table}%`],
        )
      ).rows[0]!.n;
    while ((await waits()) === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await holder.query("COMMIT");
    await applied;
    assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE done`)).rowCount, 1);
  } finally {
    holder.release();
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

test("a batched migration must report whether more batches remain", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id } = names();
  try {
    await assert.rejects(
      applyPgMigrations(pool, [definePgMigration({ id, statements: ["-- qm:batched\nSELECT 1 AS n"] })]),
      /must end by selecting a boolean more/,
    );
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id])).rowCount, 0);
  } finally {
    await pool.end();
  }
});

test("a batched migration lets other migrators through while its batches run", { skip }, async () => {
  const a = new pg.Pool({ connectionString: databaseUrl });
  const b = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const batched = definePgMigration({
    id: `${id}/batched`,
    statements: [
      `-- qm:batched
       SELECT pg_sleep(0.2);
       UPDATE ${table} SET n = n + 1;
       SELECT (SELECT n FROM ${table}) < 10 AS more`,
    ],
  });
  const other = definePgMigration({ id: `${id}/other`, statements: [`CREATE TABLE ${table}_other(value INT)`] });
  try {
    await a.query(`CREATE TABLE ${table}(n INT NOT NULL)`);
    await a.query(`INSERT INTO ${table} VALUES (0)`);
    const running = applyPgMigrations(a, [batched]);
    while ((await a.query(`SELECT n FROM ${table}`)).rows[0].n < 2) await new Promise((r) => setTimeout(r, 50));
    await applyPgMigrations(b, [other]);
    assert.ok(
      (await a.query(`SELECT n FROM ${table}`)).rows[0].n < 10,
      "the other migration did not wait for every batch",
    );
    await Promise.all([running, applyPgMigrations(b, [batched])]);
    assert.deepEqual((await a.query(`SELECT n FROM ${table}`)).rows, [{ n: 10 }]);
  } finally {
    await a.query(`DROP TABLE IF EXISTS ${table}, ${table}_other`);
    await a.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id LIKE $1`, [`${id}/%`]);
    await Promise.all([a.end(), b.end()]);
  }
});
