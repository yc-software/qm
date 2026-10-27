import { test } from "node:test";
import assert from "node:assert/strict";
import { CRONS_MIGRATION } from "../../src/cron/cron-store.ts";
import { CONFIG_TABLES } from "../../src/resolution/config-tables.ts";
import { asMapTables, migrate, skip, typedRows, withMigratedDatabase } from "../support/migrated-database.ts";

const JSON_TABLES = [
  "base_model_configs",
  "approved_harness_configs",
  "auto_flagger_configs",
  "swarms",
  "feature_flags",
];

test("stored harness choices are dropped while their runtime selections stay recognised", { skip }, async () => {
  await withMigratedDatabase(async (url, admin) => {
    await admin.query(
      "DELETE FROM qm_schema_migrations WHERE id IN ('runtime/0002-drop-harness-choice', 'runtime/0003-promote-legacy-base-models', 'durable-map/swarms/0002-drop', 'feature-flags/store/0001-typed')",
    );
    await admin.query("DROP TABLE feature_flags");
    await admin.query("DROP TABLE crons CASCADE");
    await admin.query(
      "DELETE FROM qm_schema_migrations WHERE id LIKE 'triggers/crons/%' OR id LIKE 'contract/triggers/crons/%'",
    );
    await admin.query("CREATE TABLE crons (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await asMapTables(admin, [CONFIG_TABLES.baseModels, CONFIG_TABLES.autoFlaggerConfigs]);
    for (const table of JSON_TABLES)
      await admin.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
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
    const cron = (id: string, runtime: unknown) =>
      insert("crons", id, {
        id,
        ownerScopeId: "org:o",
        owner: "a",
        createdBy: "a",
        enabled: true,
        createdAt: 1,
        schedule: {},
        ...(runtime ? { runtime } : {}),
      });
    await cron("c1", { harnessId: "claude", modelId: "m" });
    await cron("c2", null);
    await insert("swarms", "s1", { id: "s1", template: { harness: "claude", model: "m" } });
    await insert("swarms", "s2", { id: "s2", template: { model: "m" } });
    await insert("feature_flags", "swarms", { featureName: "swarms", enabledScopes: [], updatedAt: 1, updatedBy: "a" });

    await migrate(url);

    const base = await typedRows(admin, CONFIG_TABLES.baseModels);
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
    assert.deepEqual(base["personal:b"], { scopeId: "personal:b", modelId: "legacy-only", orgRevision: 0 });
    // The table stays for older images until the contract migrations drop it.
    assert.equal(
      (await admin.query("SELECT to_regclass('approved_harness_configs') AS t")).rows[0].t,
      "approved_harness_configs",
    );
    assert.deepEqual((await typedRows(admin, CONFIG_TABLES.autoFlaggerConfigs))["org:o"], {
      scopeId: "org:o",
      modelId: "m",
      rubric: "r",
    });
    const crons = await typedRows(admin, CRONS_MIGRATION.spec);
    assert.deepEqual(crons.c1?.runtime, { modelId: "m" });
    assert.equal(crons.c2?.runtime, undefined);
    assert.equal((await admin.query("SELECT to_regclass('swarms') AS t")).rows[0].t, "swarms");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM feature_flags")).rows[0].n, 0);
  });
});

test("legacy base models become runtime selections with the same model", { skip }, async () => {
  await withMigratedDatabase(async (url, admin) => {
    await admin.query("DELETE FROM qm_schema_migrations WHERE id = 'runtime/0003-promote-legacy-base-models'");
    await asMapTables(admin, [CONFIG_TABLES.baseModels]);
    await admin.query("CREATE TABLE base_model_configs (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    const insert = (id: string, json: unknown) =>
      admin.query("INSERT INTO base_model_configs (id, json) VALUES ($1, $2)", [id, JSON.stringify(json)]);
    await insert("org:o", { scopeId: "org:o", modelId: "claude-opus-5", cronRuntime: { modelId: "gpt-5.5" } });
    await insert("personal:a", { scopeId: "personal:a", modelId: "gpt-5.5" });
    await insert("personal:b", { scopeId: "personal:b", modelId: "claude-opus-5", orgRevision: 2, effortLevel: "low" });
    await insert("channel:c", { scopeId: "channel:c", embeddingModelId: "e" });

    await migrate(url);

    const base = await typedRows(admin, CONFIG_TABLES.baseModels);
    assert.deepEqual(base["org:o"], {
      scopeId: "org:o",
      modelId: "claude-opus-5",
      cronRuntime: { modelId: "gpt-5.5" },
      orgRevision: 0,
    });
    assert.deepEqual(base["personal:a"], { scopeId: "personal:a", modelId: "gpt-5.5", orgRevision: 0 });
    assert.deepEqual(
      base["personal:b"],
      { scopeId: "personal:b", modelId: "claude-opus-5", orgRevision: 2, effortLevel: "low" },
      "a row that is already a runtime selection is untouched",
    );
    assert.deepEqual(base["channel:c"], { scopeId: "channel:c", embeddingModelId: "e" }, "rows without a model stay");
  });
});
