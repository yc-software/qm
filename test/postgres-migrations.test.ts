import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  applyPgMigrations,
  createPgPool,
  definePgMigration,
  migrateRegisteredPgSchemas,
  pgMigration,
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
  const migration = pgMigration({
    id,
    concurrentIndexes: [
      { name: index, table, statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${table}(value)` },
    ],
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
  const migration = pgMigration({
    id,
    concurrentIndexes: [
      { name: index, table, statement: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${table}(value)` },
    ],
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

test("a concurrent index declared under the wrong name is not recorded", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await pool.query(`CREATE TABLE ${table}(value INT)`);
    await assert.rejects(
      applyPgMigrations(pool, [
        pgMigration({
          id,
          concurrentIndexes: [
            {
              name: `${table}_declared`,
              table,
              statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_built ON ${table}(value)`,
            },
          ],
        }),
      ]),
      /is not ready and valid/,
    );
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id])).rowCount, 0);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  }
});

test("Postgres refuses a migration element holding two statements and nothing is applied", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration(id, [`CREATE TABLE ${table}(a INT); ALTER TABLE ${table} ADD COLUMN b INT`]),
      ]),
      (error: Error) => (error.cause as { code?: string }).code === "42601" && error.message.includes(id),
    );
    assert.equal((await pool.query("SELECT to_regclass($1) AS name", [table])).rows[0].name, null);
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id])).rowCount, 0);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  }
});

test("concurrent index retry resolves indexes in the target table schema", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const schema = `s_${table}`;
  const index = `${table}_idx`;
  const migration = pgMigration({
    id,
    concurrentIndexes: [
      {
        name: index,
        table: `${schema}.events`,
        statement: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${schema}.events(value)`,
      },
    ],
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
  const migration = definePgMigration(id, [
    `CREATE TABLE ${table}(value INT NOT NULL)`,
    `INSERT INTO ${table}(value) VALUES (1)`,
  ]);
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
    await applyPgMigrations(pool, [definePgMigration(id, [`CREATE TABLE ${table}(value INT NOT NULL)`])]);
    await assert.rejects(
      applyPgMigrations(pool, [definePgMigration(id, [`CREATE TABLE ${table}(value TEXT NOT NULL)`])]),
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
        definePgMigration(id, [`CREATE TABLE ${table}(value INT NOT NULL)`, `INSERT INTO missing_${table} VALUES (1)`]),
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

test("repeatable maintenance runs once per store instance after migrations", { skip }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const maintenanceId = `${id}/maintenance`;
  const store = createPgPool(
    databaseUrl!,
    [
      {
        id,
        statements: [`CREATE TABLE ${table}(value INT NOT NULL)`, `INSERT INTO ${table}(value) VALUES (0)`],
      },
      {
        id: `${id}/0002`,
        statements: [`UPDATE ${table} SET value = value + 10`],
      },
    ],
    [{ id: maintenanceId, statements: [`UPDATE ${table} SET value = value + 1`] }],
  );
  try {
    await migrateRegisteredPgSchemas(databaseUrl);
    assert.deepEqual(await store.q(`SELECT value FROM ${table}`), [{ value: 11 }]);
    const ledger = await admin.query(`SELECT id FROM ${PG_MIGRATIONS_TABLE} WHERE id IN ($1, $2, $3) ORDER BY id`, [
      id,
      `${id}/0002`,
      maintenanceId,
    ]);
    assert.deepEqual(ledger.rows, [{ id }, { id: `${id}/0002` }]);
  } finally {
    await store.close();
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id IN ($1, $2)`, [id, `${id}/0002`]);
    await admin.end();
  }
});

test("pre-migration maintenance can repair schema before a released migration", { skip }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const store = createPgPool(
    databaseUrl!,
    [{ id, statements: [`INSERT INTO ${table}(value) VALUES (1)`] }],
    [
      {
        id: `${id}/repair`,
        beforeMigrations: true,
        statements: [`CREATE TABLE IF NOT EXISTS ${table}(value INT NOT NULL)`],
      },
    ],
  );
  try {
    assert.deepEqual(await store.q(`SELECT value FROM ${table}`), [{ value: 1 }]);
  } finally {
    await store.close();
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await admin.end();
  }
});

for (const lock of ["qm:schema-maintenance", "qm:schema-migrations"]) {
  test(`waiting for the ${lock} lock does not deadlock a concurrent index build`, { skip }, async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const holder = new pg.Client({ connectionString: databaseUrl });
    const { id, table } = names();
    const store = createPgPool(
      databaseUrl!,
      [{ id, statements: [`ALTER TABLE ${table} ADD COLUMN extra INT`] }],
      [{ id: `${id}/repair`, beforeMigrations: true, statements: ["SELECT 1"] }],
    );
    await holder.connect();
    try {
      await admin.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
      await admin.query(`INSERT INTO ${table}(value) VALUES (1)`);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
      const ready = store.pool();
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
      assert.deepEqual(await store.q(`SELECT value, extra FROM ${table}`), [{ value: 1, extra: null }]);
    } finally {
      await holder.end();
      await store.close();
      await admin.query(`DROP TABLE IF EXISTS ${table}`);
      await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
      await admin.end();
    }
  });
}
