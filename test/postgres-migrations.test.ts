import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  applyPgMigrations,
  createPgPool,
  definePgMigration,
  migrateRegisteredPgSchemas,
  PG_MIGRATIONS_TABLE,
} from "../src/persistence/pg-pool.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

function names(): { id: string; table: string } {
  const suffix = randomUUID().replaceAll("-", "");
  return { id: `test/integration/${suffix}/0001`, table: `migration_test_${suffix}` };
}

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
