import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { definePgMigration } from "../src/persistence/pg-pool.ts";
import { ABSURD_MIGRATION, ABSURD_QUEUES, ABSURD_SQL_URL } from "../src/turns/absurd-schema.ts";

test("Absurd migration runs the vendored file whole, creates every queue and matches its pin", () => {
  const migration = definePgMigration(ABSURD_MIGRATION);
  assert.equal(migration.id, "absurd/0001");
  assert.equal(migration.statements[0], readFileSync(ABSURD_SQL_URL, "utf8").trim());
  assert.deepEqual(
    migration.statements.filter((statement) => statement.startsWith("SELECT absurd.create_queue")),
    ABSURD_QUEUES.map((queue) => `SELECT absurd.create_queue('${queue}', 'unpartitioned')`),
  );
  assert.throws(
    () => definePgMigration({ ...ABSURD_MIGRATION, statements: [...ABSURD_MIGRATION.statements, "SELECT 1"] }),
    /checksum mismatch/,
  );
});

test("only a script migration may hold several statements", () => {
  const { expectedChecksum: _pin, ...unpinned } = ABSURD_MIGRATION;
  assert.throws(() => definePgMigration({ ...unpinned, script: false }), /single statement/);
});

test("vendored Absurd SQL carries no partition maintenance or pg_cron jobs", () => {
  const sql = readFileSync(ABSURD_SQL_URL, "utf8");
  for (const name of ["ensure_partitions", "schedule_detach_jobs", "enable_cron", "disable_cron"])
    assert.ok(!sql.includes(name), name);
});
