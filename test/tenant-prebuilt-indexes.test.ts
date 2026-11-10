import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { testDatabaseUrl } from "./support/test-database.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the prebuilt index drop test";
const exec = promisify(execFile);

const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });

const indexes = async (pool: pg.Pool, table: string) =>
  (
    await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY indexname",
      [table],
    )
  ).rows.map((row) => row.indexname);

test(
  "the release migration drops the indexes prebuilt for tenant-first keys and keeps the table's own",
  { skip },
  async () => {
    const url = testDatabaseUrl();
    const admin = new pg.Pool({ connectionString: url });
    try {
      await migrate(url);
      const own = await indexes(admin, "sessions");
      await admin.query("DELETE FROM qm_schema_migrations WHERE id = 'tenancy/0001-drop-prebuilt-indexes'");
      await admin.query("CREATE UNIQUE INDEX sessions_legacy_thread_ref_key ON sessions(thread_ref)");
      await admin.query("CREATE INDEX sessions_key_lookup ON sessions(id)");
      await admin.query("CREATE UNIQUE INDEX audit_log_legacy_id_key ON audit_log(id)");
      assert.ok((await indexes(admin, "sessions")).includes("sessions_legacy_thread_ref_key"));

      await migrate(url);

      assert.deepEqual(await indexes(admin, "sessions"), own);
      assert.ok(!(await indexes(admin, "audit_log")).includes("audit_log_legacy_id_key"));
      const ledger = await admin.query(
        "SELECT 1 FROM qm_schema_migrations WHERE id = 'tenancy/0001-drop-prebuilt-indexes'",
      );
      assert.equal(ledger.rowCount, 1);
    } finally {
      await admin.end();
    }
  },
);
