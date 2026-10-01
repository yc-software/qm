import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore, type FeatureFlagRecord } from "../src/feature-flags.ts";

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
