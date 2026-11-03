import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { PG_MIGRATIONS_TABLE } from "../src/persistence/pg-pool.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const exec = promisify(execFile);

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const url = testBareDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url });
  try {
    await run(url, admin);
  } finally {
    await admin.end();
  }
}

test("concurrent cold and repeat migration entrypoints exit and reject checksum drift", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    const run = () =>
      exec(process.execPath, ["src/migrate-main.ts"], {
        cwd: new URL("..", import.meta.url),
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: url,
          SANDBOX_BACKEND: "local",
          CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
        },
      });
    const cold = await Promise.all([run(), run()]);
    for (const result of [...cold, await run()]) {
      assert.match(result.stdout, /\[qm:migrate\] database migrations applied/);
    }
    const applied = await admin.query(`SELECT id FROM ${PG_MIGRATIONS_TABLE} ORDER BY id`);
    assert.ok(applied.rowCount! > 10);
    await admin.query(`UPDATE ${PG_MIGRATIONS_TABLE} SET checksum = 'invalid' WHERE id = $1`, [applied.rows[0].id]);
    await assert.rejects(run(), (error: unknown) => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /checksum mismatch/);
      assert.doesNotMatch(failure.stdout, /\[qm:migrate\] database migrations applied/);
      return true;
    });
  });
});
