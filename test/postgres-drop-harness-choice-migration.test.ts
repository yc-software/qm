import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the harness choice migration test";
const exec = promisify(execFile);
const JSON_TABLES = ["base_model_configs", "approved_harness_configs", "auto_flagger_configs", "crons", "swarms"];

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `drop_harness_${randomUUID().replaceAll("-", "")}`;
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

const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      SESSION_STORE: "postgres",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });

const rows = async (pool: pg.Pool, table: string) =>
  Object.fromEntries(
    (await pool.query(`SELECT id, json FROM ${table}`)).rows.map((row) => [row.id, row.json]),
  ) as Record<string, Record<string, unknown>>;

test("stored harness choices are dropped while their runtime selections stay recognised", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    for (const table of JSON_TABLES)
      await admin.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    const insert = (table: string, id: string, json: unknown) =>
      admin.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);
    await insert("base_model_configs", "org:o", {
      scopeId: "org:o",
      harnessId: "pi",
      modelId: "gpt-5.6-sol",
      revision: 3,
      orgRevision: 3,
      cronRuntime: { harnessId: "pi", modelId: "claude-opus-5" },
      subagentRuntime: { harnessId: "claude", modelId: "claude-opus-5", effortLevel: "low" },
      fallbackRuntime: { harnessId: "pi", modelId: "gpt-5.6-sol" },
    });
    await insert("base_model_configs", "personal:a", { scopeId: "personal:a", harnessId: "claude", modelId: "x" });
    await insert("base_model_configs", "personal:b", { scopeId: "personal:b", modelId: "legacy-only" });
    await insert("approved_harness_configs", "org:o", { scopeId: "org:o", ids: ["pi", "claude"] });
    await insert("auto_flagger_configs", "org:o", { scopeId: "org:o", harnessId: "claude", modelId: "m", rubric: "r" });
    await insert("crons", "c1", { id: "c1", runtime: { harnessId: "claude", modelId: "m" } });
    await insert("crons", "c2", { id: "c2", runtime: null });
    await insert("swarms", "s1", { id: "s1", template: { harness: "claude", model: "m" } });
    await insert("swarms", "s2", { id: "s2", template: { model: "m" } });

    await migrate(url);

    const base = await rows(admin, "base_model_configs");
    assert.deepEqual(base["org:o"], {
      scopeId: "org:o",
      modelId: "gpt-5.6-sol",
      revision: 3,
      orgRevision: 3,
      cronRuntime: { modelId: "claude-opus-5" },
      subagentRuntime: { modelId: "claude-opus-5", effortLevel: "low" },
      fallbackRuntime: { modelId: "gpt-5.6-sol" },
    });
    assert.deepEqual(base["personal:a"], { scopeId: "personal:a", modelId: "x", orgRevision: 0 });
    assert.deepEqual(base["personal:b"], { scopeId: "personal:b", modelId: "legacy-only" });
    assert.equal((await admin.query("SELECT to_regclass('approved_harness_configs') AS t")).rows[0].t, null);
    assert.deepEqual((await rows(admin, "auto_flagger_configs"))["org:o"], {
      scopeId: "org:o",
      modelId: "m",
      rubric: "r",
    });
    const crons = await rows(admin, "crons");
    assert.deepEqual(crons.c1?.runtime, { modelId: "m" });
    assert.equal(crons.c2?.runtime, null);
    const swarms = await rows(admin, "swarms");
    assert.deepEqual(swarms.s1?.template, { model: "m" });
    assert.deepEqual(swarms.s2?.template, { model: "m" });
  });
});
