import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore, type FeatureFlagRecord } from "../src/feature-flags.ts";

test("feature flags map each feature to enabled scopes", async () => {
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  assert.equal(await store.enabled("command_scoped_credentials", "channel:C1"), false);
  await store.setEnabled("command_scoped_credentials", "channel:C1", true, "admin");
  await store.setEnabled("command_scoped_credentials", "personal:U1", true, "admin");
  assert.equal(await store.enabled("command_scoped_credentials", "channel:C1"), true);
  assert.equal(await store.enabled("command_scoped_credentials", "channel:C2"), false);
  assert.deepEqual((await store.get("command_scoped_credentials"))?.enabledScopes, ["channel:C1", "personal:U1"]);
  await store.setEnabled("command_scoped_credentials", "channel:C1", false, "admin");
  assert.equal(await store.enabled("command_scoped_credentials", "channel:C1"), false);
});

test("the org scope enables a feature everywhere", async () => {
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  await store.setEnabled("command_scoped_credentials", "org:default-org", true, "admin");
  assert.equal(await store.enabled("command_scoped_credentials", "channel:C1"), true);
});
