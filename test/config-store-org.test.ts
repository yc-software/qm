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

test("purpose runtimes persist independently without manufacturing a conversation default", async () => {
  const baseModels = createMemoryMap<import("../src/resolution/config-store.ts").PersistedBaseModel>();
  const store = createMemoryConfigStore("default-org", { baseModels });
  const org = "org:default-org";
  const cron = { harnessId: "pi", modelId: "gpt-5.5", fastMode: false };
  const subagent = { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "low" };
  assert.equal(store.getPurposeRuntime("cron"), undefined);
  await store.setPurposeRuntime("cron", cron);
  await store.setPurposeRuntime("subagent", subagent);
  assert.equal(store.getBaseModel(org), null);
  assert.equal(await store.getRuntimeSelectionDurable(org), null);
  const reader = createMemoryConfigStore("default-org", { baseModels });
  await reader.hydrate!();
  assert.deepEqual(reader.getPurposeRuntime("cron"), cron);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  reader.getPurposeRuntime("cron")!.modelId = "not-persisted";
  assert.deepEqual(reader.getPurposeRuntime("cron"), cron);
  await store.setRuntimeSelectionLatest(org, { harnessId: "pi", modelId: "gpt-5.5" });
  await store.setRuntimeSelectionLatest(org, null);
  store.setRuntimeSelection(org, null);
  store.setRuntimeSelection(org, { harnessId: "pi", modelId: "gpt-5.5" });
  await store.flushScope(org);
  assert.equal(store.getRuntimeSelection(org)?.modelId, "gpt-5.5");
  store.setBaseModel(org, "gpt-5.5");
  store.setBaseModel(org, null);
  await store.flushScope(org);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("cron"), cron);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  await store.clearPurposeRuntime("cron");
  assert.equal(await reader.getPurposeRuntimeDurable("cron"), undefined);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  await store.clearPurposeRuntime("subagent");
  assert.equal(await baseModels.get(org), null);
});
