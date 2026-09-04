import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedDeploymentIdentity } from "../src/resolution/config-store.ts";

test("a durable database is pinned to one organization", async () => {
  const deploymentIdentity = createMemoryMap<PersistedDeploymentIdentity>();
  await createMemoryConfigStore("default-org", { deploymentIdentity }).hydrate!();
  await assert.rejects(
    createMemoryConfigStore("other", { deploymentIdentity }).hydrate!(),
    /database belongs to org default-org/,
  );
});
