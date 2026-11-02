import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { rawPg } from "./support/raw-pg.ts";

const url = process.env.DATABASE_URL;

for (const legacyApplied of [false, true]) {
  test(`legacy migration adoption preserves a completed sweep: ${legacyApplied}`, { skip: !url }, async () => {
    const pool = rawPg(url!);
    const suffix = randomUUID().replaceAll("-", "");
    const table = `adoption_${suffix}`;
    const id = `test/adoption/${suffix}`;
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await pool.query(`CREATE TABLE ${table} (enabled boolean NOT NULL)`);
      await pool.query(`INSERT INTO ${table} VALUES (true)`);
      if (legacyApplied) await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      const migration = definePgMigration({ id, statements: [`UPDATE ${table} SET enabled = false`], legacyId: id });
      await applyPgMigrations(await pool.pool(), [migration]);
      assert.equal((await pool.query(`SELECT enabled FROM ${table}`)).rows[0].enabled, legacyApplied);
      await pool.query(`UPDATE ${table} SET enabled = true`);
      await applyPgMigrations(await pool.pool(), [definePgMigration({ id, statements: migration.statements })]);
      assert.equal((await pool.query(`SELECT enabled FROM ${table}`)).rows[0].enabled, true);
      await assert.rejects(
        applyPgMigrations(await pool.pool(), [definePgMigration({ id, statements: ["SELECT 1"], legacyId: id })]),
        /checksum mismatch/,
      );
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
      await pool.query("DELETE FROM qm_schema_migrations WHERE id = $1", [id]);
      await pool.close();
    }
  });
}
