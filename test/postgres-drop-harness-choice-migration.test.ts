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
    const cron = {
      owner: "a",
      createdBy: "a",
      ownerScopeId: "personal:a",
      schedule: { everyMs: 60_000 },
      enabled: true,
    };
    await insert("crons", "c1", { ...cron, id: "c1", runtime: { harnessId: "claude", modelId: "m" } });
    await insert("crons", "c2", { ...cron, id: "c2", runtime: null });
    const swarm = { scopeId: "personal:a", ownerId: "a", backend: "modal", settings: {} };
    await insert("swarms", "s1", { ...swarm, id: "s1", template: { harness: "claude", model: "m" } });
    await insert("swarms", "s2", { ...swarm, id: "s2", template: { model: "m" } });

    await migrate(url);

    const runtimes = await admin.query(
      `SELECT scope_id, model_id, runtime_revision, org_revision FROM scope_settings ORDER BY scope_id`,
    );
    assert.deepEqual(runtimes.rows, [
      { scope_id: "org:o", model_id: "gpt-5.6-sol", runtime_revision: 3, org_revision: 3 },
      { scope_id: "personal:a", model_id: "x", runtime_revision: null, org_revision: 0 },
      { scope_id: "personal:b", model_id: "legacy-only", runtime_revision: null, org_revision: null },
    ]);
    const purposes = await admin.query(`SELECT purpose, model_id, effort_level FROM purpose_runtimes ORDER BY purpose`);
    assert.deepEqual(purposes.rows, [
      { purpose: "cron", model_id: "claude-opus-5", effort_level: null },
      { purpose: "fallback", model_id: "gpt-5.6-sol", effort_level: null },
      { purpose: "subagent", model_id: "claude-opus-5", effort_level: "low" },
    ]);
    const dropped = await admin.query(
      "SELECT to_regclass('approved_harness_configs') AS approved, to_regclass('base_model_configs') AS base",
    );
    assert.deepEqual(dropped.rows[0], { approved: null, base: null });
    const flagger = await admin.query(`SELECT auto_flagger_model_id, auto_flagger_rubric FROM operator_settings`);
    assert.deepEqual(flagger.rows, [{ auto_flagger_model_id: "m", auto_flagger_rubric: "r" }]);
    const column = async (table: string, name: string) =>
      Object.fromEntries(
        (await admin.query(`SELECT id, ${name} AS value FROM ${table}`)).rows.map((row) => [row.id, row.value]),
      );
    const crons = await column("crons", "runtime");
    assert.deepEqual(crons.c1, { modelId: "m" });
    assert.equal(crons.c2, null);
    const swarms = await column("swarms", "template");
    assert.deepEqual(swarms.s1, { model: "m" });
    assert.deepEqual(swarms.s2, { model: "m" });
  });
});
