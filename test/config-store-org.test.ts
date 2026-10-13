import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type PersistedBrowseModel,
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

test("flushScope reports every failed config write for the scope once, with its cause", async () => {
  const failing = <T>(message: string) => ({
    ...createMemoryMap<T>(),
    put: async () => {
      throw new Error(message);
    },
  });
  const config = createMemoryConfigStore("org-a", {
    browseModels: failing("browse model write failed"),
    commandPolicies: failing("policy write failed"),
  });
  config.setBrowseModel("org:org-a", "model-x");
  await assert.rejects(config.flushScope("org:org-a"), /browse model write failed/);
  config.setOrgAmbient(true);
  await config.flushScope("org:org-a");

  config.setBrowseModel("org:org-a", "model-y");
  config.setCommandPolicy("org:org-a", { mode: "denylist", rules: [] });
  await assert.rejects(config.flushScope("org:org-a"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((e: Error) => e.message).sort(), [
      "browse model write failed",
      "policy write failed",
    ]);
    return true;
  });
});

test("a write that starts during a failing flush is still awaited by the next flush", async () => {
  const stored = createMemoryMap<PersistedBrowseModel>();
  const firstGate = Promise.withResolvers<void>();
  const secondGate = Promise.withResolvers<void>();
  let calls = 0;
  const config = createMemoryConfigStore("org-a", {
    browseModels: {
      ...stored,
      put: async (key, value) => {
        if (calls++ === 0) {
          await firstGate.promise;
          throw new Error("first write failed");
        }
        await secondGate.promise;
        await stored.put(key, value);
      },
    },
  });
  config.setBrowseModel("org:org-a", "model-x");
  const first = config.flushScope("org:org-a");
  config.setBrowseModel("org:org-a", "model-y");
  firstGate.resolve();
  await assert.rejects(first, /first write failed/);

  let secondSettled = false;
  const second = config.flushScope("org:org-a").finally(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  secondGate.resolve();
  await second;
  assert.equal((await stored.get("org:org-a"))?.modelId, "model-y");
});
