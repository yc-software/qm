import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type PersistedDeploymentIdentity,
  type PersistedInternalMemberOverrides,
} from "../src/resolution/config-store.ts";

test("a durable database is pinned to one organization", async () => {
  const deploymentIdentity = createMemoryMap<PersistedDeploymentIdentity>();
  await createMemoryConfigStore("default-org", { deploymentIdentity }).hydrate!();
  await assert.rejects(
    createMemoryConfigStore("other", { deploymentIdentity }).hydrate!(),
    /database belongs to org default-org/,
  );
});

test("internal member overrides normalize, persist org-wide, and hydrate back", async () => {
  const internalMemberOverrides = createMemoryMap<PersistedInternalMemberOverrides>();
  const store = createMemoryConfigStore("default-org", { internalMemberOverrides });
  await store.hydrate!();
  assert.deepEqual(store.getInternalMemberOverrides(), []);
  store.setInternalMemberOverrides(["  Contractor@EXAMPLE.com ", "U123ABC", "contractor@example.com", ""]);
  assert.deepEqual(store.getInternalMemberOverrides(), ["contractor@example.com", "u123abc"]);
  await store.flushScope("org:default-org");
  assert.deepEqual(await store.getInternalMemberOverridesDurable(), ["contractor@example.com", "u123abc"]);
  const rehydrated = createMemoryConfigStore("default-org", { internalMemberOverrides });
  await rehydrated.hydrate!();
  assert.deepEqual(rehydrated.getInternalMemberOverrides(), ["contractor@example.com", "u123abc"]);
});
