import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeatureFlagStore, postgresFeatureFlags, type FeatureFlagRecord } from "../src/feature-flags.ts";
import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { FEATURE_FLAGS_MIGRATION, TENANCY_BASE } from "../src/tenants/migrations.ts";
import { testTenants } from "./support/test-tenants.ts";
import { testBareDatabaseUrl, testMap, testMigratedDatabaseUrl } from "./support/test-database.ts";

const [TEST_TENANT, OTHER_TENANT] = testTenants();

test("feature flags map each feature to enabled scopes", async () => {
  const store = createFeatureFlagStore(testMap<FeatureFlagRecord>());
  assert.equal(await store.enabled("inbox_loops", "channel:C1"), false);
  await store.setEnabled("inbox_loops", "channel:C1", true, "admin");
  await store.setEnabled("inbox_loops", "personal:U1", true, "admin");
  assert.equal(await store.enabled("inbox_loops", "channel:C1"), true);
  assert.equal(await store.enabled("inbox_loops", "channel:C2"), false);
  assert.deepEqual((await store.get("inbox_loops"))?.enabledScopes, ["channel:C1", "personal:U1"]);
  await store.setEnabled("inbox_loops", "channel:C1", false, "admin");
  assert.equal(await store.enabled("inbox_loops", "channel:C1"), false);
});

test("the org scope enables a feature everywhere", async () => {
  const store = createFeatureFlagStore(testMap<FeatureFlagRecord>());
  await store.setEnabled("inbox_loops", "org:default-org", true, "admin");
  assert.equal(await store.enabled("inbox_loops", "channel:C1"), true);
});

test("persistent subagents default off and can be enabled for individual people", async () => {
  const store = createFeatureFlagStore(testMap<FeatureFlagRecord>());
  assert.equal(await store.enabled("persistent_subagents", "personal:U1"), false);
  await store.setEnabled("persistent_subagents", "personal:U1", true, "admin");
  assert.equal(await store.enabled("persistent_subagents", "personal:U1"), true);
  assert.equal(await store.enabled("persistent_subagents", "personal:U2"), false);
  assert.equal(await store.enabled("persistent_subagents", "channel:C1"), false);
});

test("responsive spine defaults off and its cohort is independent of subagent access", async () => {
  const store = createFeatureFlagStore(testMap<FeatureFlagRecord>());
  await store.setEnabled("persistent_subagents", "personal:U2", true, "admin");
  assert.equal(await store.enabled("responsive_spine", "personal:U2"), false);
  await store.setEnabled("responsive_spine", "personal:U1", true, "admin");
  assert.equal(await store.enabled("responsive_spine", "personal:U1"), true);
  assert.equal(await store.enabled("responsive_spine", "personal:U2"), false);
  assert.equal(await store.enabled("responsive_spine", "channel:C1"), false);
  await store.setEnabled("responsive_spine", "personal:U1", false, "admin");
  assert.equal(await store.enabled("responsive_spine", "personal:U1"), false);
});

test("retired feature records are not offered as configurable flags", async () => {
  const backing = testMap<FeatureFlagRecord>();
  await backing.put("command_scoped_credentials", {
    featureName: "command_scoped_credentials",
    enabledScopes: ["channel:C1"],
    updatedAt: 1,
    updatedBy: "admin",
  } as unknown as FeatureFlagRecord);
  const store = createFeatureFlagStore(backing);
  await store.setEnabled("inbox_loops", "channel:C1", true, "admin");
  assert.deepEqual(
    (await store.list()).map((row) => row.featureName),
    ["inbox_loops"],
  );
});

test("each tenant keeps its own flags for the same person", async () => {
  const store = createFeatureFlagStore(postgresFeatureFlags(testMigratedDatabaseUrl()));
  await withTenant(TEST_TENANT, () => store.setEnabled("inbox_loops", "personal:ada", true, "operator"));
  assert.equal(await withTenant(OTHER_TENANT, () => store.enabled("inbox_loops", "personal:ada")), false);
  await withTenant(OTHER_TENANT, () => store.setEnabled("swarms", "personal:ada", true, "admin"));
  assert.equal(await withTenant(TEST_TENANT, () => store.enabled("inbox_loops", "personal:ada")), true);
  assert.equal(await withTenant(TEST_TENANT, () => store.enabled("swarms", "personal:ada")), false);
  assert.deepEqual(await withTenant(OTHER_TENANT, () => store.get("swarms")), {
    featureName: "swarms",
    enabledScopes: ["personal:ada"],
    updatedAt: (await withTenant(OTHER_TENANT, () => store.get("swarms")))!.updatedAt,
    updatedBy: "admin",
  });
});

test("upgrading moves the install's existing flags into its original tenant", async () => {
  const url = testBareDatabaseUrl();
  const raw = new pg.Client({ connectionString: url });
  await raw.connect();
  try {
    const original = TEST_TENANT;
    await raw.query("CREATE TABLE qm_tenant (id UUID PRIMARY KEY)");
    await raw.query("INSERT INTO qm_tenant VALUES ($1)", [original]);
    await raw.query("CREATE TABLE feature_flags (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await raw.query("INSERT INTO feature_flags VALUES ('inbox_loops', $1)", [
      { featureName: "inbox_loops", enabledScopes: ["personal:ada"], updatedAt: 1_700_000_000_000, updatedBy: "admin" },
    ]);
    const owner = new pg.Pool({ connectionString: url, max: 1 });
    await applyPgMigrations(owner, [TENANCY_BASE, FEATURE_FLAGS_MIGRATION].map(definePgMigration)).finally(() =>
      owner.end(),
    );
    const { rows } = await raw.query(
      "SELECT tenant_id::text AS tenant, feature_name, enabled_scopes, updated_by FROM feature_flags",
    );
    assert.deepEqual(rows, [
      { tenant: original, feature_name: "inbox_loops", enabled_scopes: ["personal:ada"], updated_by: "admin" },
    ]);
    assert.equal((await raw.query("SELECT to_regclass('feature_flags_json') AS t")).rows[0].t, null);
  } finally {
    await raw.end();
  }
});
