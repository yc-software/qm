import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { LEGACY_HARNESS_MIGRATION } from "../src/model/legacy-harness-migration.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the legacy harness migration test";
const JSON_TABLES = ["base_model_configs", "approved_harness_configs", "auto_flagger_configs", "crons", "swarms"];
const TABLES = [...JSON_TABLES, "sessions", "runs", "session_entries"];

async function withPool(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")}`);
    await pool.query("CREATE TABLE IF NOT EXISTS qm_schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL)");
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = 'runtime/0001-legacy-harnesses-to-pi'");
    await fn(pool);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")}`);
    await pool.end();
  }
}

async function migrate(pool: Pool, run: number): Promise<void> {
  const migration = LEGACY_HARNESS_MIGRATION;
  if (run === 1) await applyPgMigrations(pool, [definePgMigration(migration.id, migration.statements)]);
  else for (const statement of migration.statements) await pool.query(statement);
}

async function createSchema(pool: Pool): Promise<void> {
  for (const table of JSON_TABLES) await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
  await pool.query("CREATE TABLE sessions (id TEXT PRIMARY KEY, thread_ref TEXT UNIQUE NOT NULL, spawn_meta TEXT)");
  await pool.query(
    "CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL)",
  );
  await pool.query(
    "CREATE TABLE session_entries (session_id TEXT NOT NULL, seq INT NOT NULL, type TEXT NOT NULL, payload TEXT, PRIMARY KEY(session_id, seq))",
  );
}

const insert = (pool: Pool, table: string, id: string, json: unknown) =>
  pool.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);

const rows = async (pool: Pool, table: string) =>
  Object.fromEntries(
    (await pool.query(`SELECT id, json FROM ${table}`)).rows.map((row) => [row.id, row.json]),
  ) as Record<string, Record<string, unknown>>;

const handoff = (runId: string, harnessId: string, modelId = "gpt-5.6-sol") =>
  JSON.stringify({ tool: "runtime", runId, actorId: "alice", runtimeHandoff: { choice: { harnessId, modelId } } });

async function entryPayloads(pool: Pool) {
  return Object.fromEntries(
    (await pool.query("SELECT session_id || ':' || seq AS id, payload FROM session_entries")).rows.map((row) => [
      row.id,
      row.payload.startsWith("{") ? JSON.parse(row.payload) : row.payload,
    ]),
  );
}

test("a migration on a database without runtime tables or newer columns applies cleanly", { skip }, async () => {
  await withPool(async (pool) => {
    await pool.query("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    await pool.query("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    await migrate(pool, 1);
    const applied = await pool.query("SELECT id FROM qm_schema_migrations WHERE id = $1", [
      LEGACY_HARNESS_MIGRATION.id,
    ]);
    assert.equal(applied.rows.length, 1);
  });
});

test("legacy codex and opencode runtime settings move to pi and the migration is idempotent", { skip }, async () => {
  await withPool(async (pool) => {
    await createSchema(pool);
    await insert(pool, "base_model_configs", "org:o", {
      scopeId: "org:o",
      harnessId: "codex",
      modelId: "gpt-5.6-sol",
      effortLevel: "xhigh",
      cronRuntime: { harnessId: "opencode", modelId: "claude-opus-5" },
      subagentRuntime: { harnessId: "claude", modelId: "claude-opus-5" },
      fallbackRuntime: { harnessId: "codex", modelId: "gpt-5.6-sol" },
    });
    await insert(pool, "base_model_configs", "personal:a", {
      scopeId: "personal:a",
      harnessId: "claude",
      modelId: "x",
    });
    await insert(pool, "base_model_configs", "personal:b", { scopeId: "personal:b", modelId: "legacy-only" });
    await insert(pool, "approved_harness_configs", "org:o", {
      scopeId: "org:o",
      ids: ["codex", "claude", "pi", "opencode"],
    });
    await insert(pool, "approved_harness_configs", "org:p", { scopeId: "org:p", ids: ["opencode", "codex"] });
    await insert(pool, "approved_harness_configs", "org:q", { scopeId: "org:q", ids: ["claude", "mock"] });
    await insert(pool, "auto_flagger_configs", "org:o", {
      scopeId: "org:o",
      harnessId: "codex",
      modelId: "m",
      rubric: "r",
    });
    await insert(pool, "crons", "c1", { id: "c1", runtime: { harnessId: "opencode", modelId: "m" } });
    await insert(pool, "crons", "c2", { id: "c2", runtime: null });
    await insert(pool, "crons", "c3", { id: "c3", runtime: { harnessId: "claude", modelId: "m" } });
    await insert(pool, "swarms", "s1", { id: "s1", template: { harness: "codex", model: "m" } });
    await insert(pool, "swarms", "s2", { id: "s2", template: { model: "m" } });
    await pool.query(
      "INSERT INTO sessions VALUES ('sess-child', 'agent:main:subagent:child', $1), ('sess-plain', 'web:alice:1', NULL), ('sess-other', 'web:alice:2', $2), ('sess-live', 'web:alice:live', NULL), ('sess-old', 'web:alice:old', NULL)",
      [JSON.stringify({ model: "m", harness: "opencode" }), JSON.stringify({ harness: "claude" })],
    );
    await pool.query(
      "INSERT INTO runs VALUES ('r1', 'web:alice:live', 'pending', $1), ('r2', 'web:alice:old', 'done', $1), ('r3', 'web:alice:2', 'running', $2)",
      [JSON.stringify({ harness: "codex", text: "hi" }), JSON.stringify({ text: "hi" })],
    );
    await pool.query(
      "INSERT INTO session_entries VALUES ('sess-live', 1, 'tool_result', $1), ('sess-live', 2, 'tool_result', $2), ('sess-old', 1, 'tool_result', $3), ('sess-live', 3, 'user', $4), ('sess-live', 4, 'tool_result', 'plain text')",
      [
        handoff("r1", "codex"),
        handoff("r0", "codex"),
        handoff("r2", "codex"),
        JSON.stringify({ text: '"runtimeHandoff" codex' }),
      ],
    );

    for (const run of [1, 2]) {
      await migrate(pool, run);
      const base = await rows(pool, "base_model_configs");
      assert.deepEqual(
        base["org:o"],
        {
          scopeId: "org:o",
          harnessId: "pi",
          modelId: "gpt-5.6-sol",
          effortLevel: "xhigh",
          cronRuntime: { harnessId: "pi", modelId: "claude-opus-5" },
          subagentRuntime: { harnessId: "claude", modelId: "claude-opus-5" },
          fallbackRuntime: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        },
        `run ${run}`,
      );
      assert.equal(base["personal:a"]?.harnessId, "claude");
      assert.deepEqual(base["personal:b"], { scopeId: "personal:b", modelId: "legacy-only" });
      const approved = await rows(pool, "approved_harness_configs");
      assert.deepEqual(approved["org:o"]?.ids, ["pi", "claude"]);
      assert.deepEqual(approved["org:p"]?.ids, ["pi"]);
      assert.deepEqual(approved["org:q"]?.ids, ["claude", "mock"]);
      assert.deepEqual((await rows(pool, "auto_flagger_configs"))["org:o"], {
        scopeId: "org:o",
        harnessId: "pi",
        modelId: "m",
        rubric: "r",
      });
      const crons = await rows(pool, "crons");
      assert.deepEqual(crons.c1?.runtime, { harnessId: "pi", modelId: "m" });
      assert.equal(crons.c2?.runtime, null);
      assert.deepEqual(crons.c3?.runtime, { harnessId: "claude", modelId: "m" });
      const swarms = await rows(pool, "swarms");
      assert.deepEqual(swarms.s1?.template, { harness: "pi", model: "m" });
      assert.deepEqual(swarms.s2?.template, { model: "m" });
      const sessions = Object.fromEntries(
        (await pool.query("SELECT id, spawn_meta FROM sessions")).rows.map((row) => [row.id, row.spawn_meta]),
      );
      assert.deepEqual(JSON.parse(sessions["sess-child"]), { model: "m", harness: "pi" });
      assert.equal(sessions["sess-plain"], null);
      assert.deepEqual(JSON.parse(sessions["sess-other"]), { harness: "claude" });
      const runs = Object.fromEntries(
        (await pool.query("SELECT id, request FROM runs")).rows.map((row) => [row.id, JSON.parse(row.request)]),
      );
      assert.equal(runs.r1.harness, "pi");
      assert.equal(runs.r2.harness, "codex");
      assert.equal(runs.r3.harness, undefined);
      const entries = await entryPayloads(pool);
      assert.equal(entries["sess-live:1"].runtimeHandoff.choice.harnessId, "pi");
      assert.equal(entries["sess-live:1"].runtimeHandoff.choice.modelId, "gpt-5.6-sol");
      assert.equal(entries["sess-live:2"].runtimeHandoff.choice.harnessId, "codex");
      assert.equal(entries["sess-old:1"].runtimeHandoff.choice.harnessId, "codex");
      assert.deepEqual(entries["sess-live:3"], { text: '"runtimeHandoff" codex' });
      assert.equal(entries["sess-live:4"], "plain text");
    }
  });
});
