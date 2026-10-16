import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore, type FeatureFlagRecord } from "../src/feature-flags.ts";
import { scopeId } from "../src/types.ts";

test("feature flags map each feature to enabled scopes", async () => {
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
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
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  await store.setEnabled("inbox_loops", "org:default-org", true, "admin");
  assert.equal(await store.enabled("inbox_loops", "channel:C1"), true);
});

test("persistent subagents default off and can be enabled for individual people", async () => {
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  assert.equal(await store.enabled("persistent_subagents", "personal:U1"), false);
  await store.setEnabled("persistent_subagents", "personal:U1", true, "admin");
  assert.equal(await store.enabled("persistent_subagents", "personal:U1"), true);
  assert.equal(await store.enabled("persistent_subagents", "personal:U2"), false);
  assert.equal(await store.enabled("persistent_subagents", "channel:C1"), false);
});

test("responsive spine defaults off and its cohort is independent of subagent access", async () => {
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
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
  const backing = createMemoryMap<FeatureFlagRecord>();
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

for (const [label, skip, backing] of [
  ["memory", false, () => createMemoryMap<FeatureFlagRecord>()],
  [
    "postgres",
    process.env.DATABASE_URL ? false : "set DATABASE_URL to run against Postgres",
    () =>
      createPostgresMapFactory(process.env.DATABASE_URL!).map<FeatureFlagRecord>(
        `flag_race_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      ),
  ],
] as const) {
  test(`${label}: enabling a flag for several scopes at once keeps every scope`, { skip }, async () => {
    const flags = createFeatureFlagStore(backing());
    const scopes = ["U1", "U2", "U3", "U4", "U5"].map((u) => scopeId("personal", u));
    await flags.setEnabled("swarms", scopes[0]!, true, "admin");
    await Promise.all(scopes.slice(1).map((s) => flags.setEnabled("swarms", s, true, "admin")));
    assert.deepEqual((await flags.get("swarms"))!.enabledScopes, [...scopes].sort());
  });
}

test(
  "postgres: the very first enables of a flag race without losing a scope",
  { skip: process.env.DATABASE_URL ? false : "set DATABASE_URL to run against Postgres" },
  async () => {
    const flags = createFeatureFlagStore(
      createPostgresMapFactory(process.env.DATABASE_URL!).map<FeatureFlagRecord>(`flag_first_${Date.now()}`),
    );
    const scopes = ["U1", "U2", "U3"].map((u) => scopeId("personal", u));
    await Promise.all(scopes.map((s) => flags.setEnabled("swarms", s, true, "admin")));
    assert.deepEqual((await flags.get("swarms"))!.enabledScopes, [...scopes].sort());
  },
);
