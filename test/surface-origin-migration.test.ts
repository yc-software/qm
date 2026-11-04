import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { RETIRED_ORIGIN_SWEEP_MIGRATION } from "../src/surfaces/origin-migration.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the retired origin sweep tests";
const exec = promisify(execFile);

async function withDatabase(run: (url: string, db: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `origin_sweep_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const db = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), db);
  } finally {
    await db.end();
    while ((await parent.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [name])).rowCount) await sleep(20);
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

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

const request = (extra: Record<string, unknown>) => ({
  surface: "cron",
  actor: { externalId: "internal:owner" },
  conversation: { kind: "dm", threadRef: "t1" },
  text: "x",
  ...extra,
});

async function forgetSweep(db: pg.Pool, ...ids: string[]): Promise<void> {
  await db.query(`DELETE FROM qm_schema_migrations WHERE id = ANY($1)`, [[RETIRED_ORIGIN_SWEEP_MIGRATION.id, ...ids]]);
}

async function seedRun(db: pg.Pool): Promise<void> {
  await db.query(
    `INSERT INTO runs (id, session_id, status, request, created_at)
     VALUES ('r1', 's1', 'done', $1, 1)`,
    [JSON.stringify(request({ origin: { kind: "automation" } }))],
  );
}

test("the retired origin sweep refuses a database that never stored typed origins", { skip }, async () => {
  await withDatabase(async (url, db) => {
    await migrate(url);
    await seedRun(db);
    await forgetSweep(db, "surfaces/0004-settled-runs-rewrite");
    await assert.rejects(migrate(url), /run a release that records surfaces\/0004-settled-runs-rewrite first/);
  });
});

test("the retired origin sweep deletes approvals that only carry retired origin fields", { skip }, async () => {
  await withDatabase(async (url, db) => {
    await migrate(url);
    await seedRun(db);
    await forgetSweep(db);
    await db.query(
      `INSERT INTO qm_schema_migrations (id, checksum) VALUES ('surfaces/0004-settled-runs-rewrite', 'x')`,
    );
    const approvals = {
      legacy: { sessionId: "s1", command: "c", request: request({ triggered: true, securityScreenData: "event" }) },
      typed: {
        sessionId: "s1",
        command: "c",
        request: request({ triggered: true, origin: { kind: "automation", screenData: "event" } }),
      },
      direct: { sessionId: "s1", command: "c", request: request({}) },
    };
    for (const [id, json] of Object.entries(approvals))
      await db.query(`INSERT INTO approvals (id, json) VALUES ($1, $2)`, [id, json]);
    await db.query(`CREATE TABLE surface_origin_settled_candidates (id TEXT PRIMARY KEY)`);
    await migrate(url);
    const kept = await db.query<{ id: string }>(`SELECT id FROM approvals ORDER BY id`);
    assert.deepEqual(
      kept.rows.map((r) => r.id),
      ["direct", "typed"],
    );
    const leftover = await db.query(`SELECT to_regclass('surface_origin_settled_candidates') AS t`);
    assert.equal(leftover.rows[0].t, null);
  });
});
