import assert from "node:assert/strict";
import test from "node:test";
import { blobTables, featureFlags, NAME_RULES, names } from "../../scripts/code-ratchets.ts";

const [legacy, mode, kv, flag] = NAME_RULES;

test("legacy names count in code, string literals and SQL alike", () => {
  const code = `const legacyRuns = db.where("engine = 'legacy'");\nif (run.engine === 'legacy-runner') LEGACY_SLOTS++;\nALTER TABLE runs ADD legacy_engine text;`;
  assert.deepEqual(
    [...names(code, legacy!)],
    ["legacyRuns", "legacy", "legacy-runner", "LEGACY_SLOTS", "legacy_engine"],
  );
});

test("mode and flag env names count wherever they appear", () => {
  const config = `SLACK_EVENTS_MODE: "socket"\nprocess.env.DEPLOYMENTS_ENABLED\nENABLE_X=1 DISABLE_Y=1 storage_mode`;
  assert.deepEqual([...names(config, mode!)], ["SLACK_EVENTS_MODE"]);
  assert.deepEqual([...names(config, flag!)], ["DEPLOYMENTS_ENABLED", "ENABLE_X", "DISABLE_Y"]);
});

test("feature flags are the top-level keys of FEATURES", () => {
  const source = `export const FEATURES = {\n  team_scopes: { label: "Team" },\n  ui_canvas: {\n    label: "UI",\n    hint: "x",\n  },\n} as const;\nconst OTHER = {\n  not_a_flag: 1,\n};`;
  assert.deepEqual([...featureFlags(source)], ["team_scopes", "ui_canvas"]);
});

test("id-plus-JSON tables are blob tables, typed tables are not", () => {
  const sql = `CREATE TABLE IF NOT EXISTS Artifacts (id TEXT PRIMARY KEY, json JSONB NOT NULL, tenant_id TEXT, updated_at TIMESTAMPTZ);
    CREATE TABLE ack_emoji (\n  id text NOT NULL,\n  "json" jsonb NOT NULL\n);
    CREATE TABLE IF NOT EXISTS \${table} (key TEXT, value JSON, PRIMARY KEY (tenant_id, key));
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, meta JSONB, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE pairs (a TEXT, b NUMERIC(10, 2));`;
  assert.deepEqual([...blobTables(sql, "src/x.ts")], ["artifacts", "ack_emoji", "src/x.ts:${table}"]);
});

test("generic key-value helpers count, typed stores do not", () => {
  const helper = `export function createMap<T>(table: string): DurableMap<T> {}\nconst artifactMap = pgKvStore("a");`;
  assert.deepEqual([...names(helper, kv!)], ["createMap", "DurableMap", "artifactMap", "pgKvStore"]);
  const typed = `const notes = typedTable<Note>({ table: "notes", key: "id", columns: cols("title text!, meta jsonb") });\nconst byId = new Map<string, Note>();`;
  assert.deepEqual([...names(typed, kv!)], []);
});
