import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { createPgPool, migrateRegisteredPgSchemas, PG_MIGRATIONS_TABLE } from "../src/persistence/pg-pool.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const exec = promisify(execFile);

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `migration_startup_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

test("slow lazy migrations queue with dynamic and bulk migrations before pool acquisition", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    const slow = createPgPool(url, "startup/0001", ["SELECT pg_sleep(11)"]);
    const next = createPgPool(url, "startup/0002", ["CREATE TABLE startup_result(value INT)"]);
    try {
      const first = slow.q("SELECT 1");
      const second = next.q("SELECT 2");
      const dynamic = next.migrate({ id: "startup/0003", statements: ["INSERT INTO startup_result VALUES (3)"] });
      await Promise.all([first, second, dynamic, migrateRegisteredPgSchemas(url)]);
      assert.deepEqual((await admin.query("SELECT value FROM startup_result")).rows, [{ value: 3 }]);
      assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${PG_MIGRATIONS_TABLE}`)).rows[0].count, 3);
      await assert.rejects(next.migrate({ id: "startup/0004", statements: ["SELECT * FROM missing_table"] }));
      await next.migrate({ id: "startup/0005", statements: ["INSERT INTO startup_result VALUES (5)"] });
      assert.deepEqual((await admin.query("SELECT value FROM startup_result ORDER BY value")).rows, [
        { value: 3 },
        { value: 5 },
      ]);
    } finally {
      await Promise.all([slow.close(), next.close()]);
    }
  });
});

test("migration entrypoint exits after cold and repeat startup and rejects checksum drift", { skip }, async () => {
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
          SESSION_STORE: "postgres",
          ORG_ID: "migration-test",
          CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
        },
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run();
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
