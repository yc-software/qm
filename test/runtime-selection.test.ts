import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryConfigStore,
  type PersistedApprovedHarnesses,
  type PersistedBaseModel,
} from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { registerOpenRouterCatalogModel } from "../src/model/pi-models.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ORG = "org:default-org" as const;
const PERSONAL = "personal:alice" as const;

test("runtime selection is sparse, revisioned, and acknowledges a changed org default", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  config.setRuntimeSelection(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  await config.flushScope(ORG);
  await config.flushScope(PERSONAL);

  assert.equal(config.getRuntimeSelection(ORG)?.revision, 1);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  assert.equal(config.getRuntimeSelection(ORG)?.revision, 2);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  config.acknowledgeRuntimeSelection(PERSONAL);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 2);

  config.setRuntimeSelection(PERSONAL, null);
  assert.equal(config.getRuntimeSelection(PERSONAL), null);
});

test("runtime resolution uses explicit choice, then scope, then org and rejects unapproved requests", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  config.setRuntimeSelection(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), { harnessId: "codex", modelId: "gpt-5.5" });
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-sonnet-4-6" }),
    { harnessId: "pi", modelId: "claude-sonnet-4-6" },
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "opencode", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("runtime resolution falls back to the first approved harness when deployment defaults are not approved", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["codex"]);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "claude-opus-4-8" }), {
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
  });
});

test("runtime resolution reads approvals and selections from shared durable state on every turn", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const approvedHarnesses = createMemoryMap<PersistedApprovedHarnesses>();
  const writer = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const reader = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  writer.setApprovedHarnesses(["pi"]);
  await writer.setRuntimeSelectionLatest(ORG, fallback);
  await writer.flushScope(ORG);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), fallback);

  writer.setApprovedHarnesses(["codex"]);
  await writer.setRuntimeSelectionLatest(ORG, { harnessId: "codex", modelId: "gpt-5.5" });
  await writer.flushScope(ORG);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), {
    harnessId: "codex",
    modelId: "gpt-5.5",
  });
  await assert.rejects(
    resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("every write that changes a scope's served model notifies listeners", async () => {
  const config = createMemoryConfigStore("default-org");
  const seen: string[] = [];
  config.onRuntimeSelectionChanged((id) => seen.push(id));
  config.setApprovedHarnesses(["pi", "codex"]);

  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  await config.setRuntimeSelectionLatest(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  config.setBaseModel(PERSONAL, "gpt-5.6-sol");
  await config.setRuntimeSelectionLatest(PERSONAL, null);
  config.acknowledgeRuntimeSelection(PERSONAL);
  assert.deepEqual(seen, [ORG, PERSONAL, PERSONAL, PERSONAL]);
});

test("a listener that throws cannot break the write that notified it", async () => {
  const config = createMemoryConfigStore("default-org");
  config.onRuntimeSelectionChanged(() => {
    throw new Error("surface unreachable");
  });
  config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelectionLatest(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  assert.equal((await config.getRuntimeSelectionDurable(ORG))?.modelId, "claude-opus-4-8");
});

test("durable runtime resolution hydrates the model catalog before rejecting an unknown dynamic model", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelectionLatest(PERSONAL, { harnessId: "pi", modelId: "testvendor/cold-router-model" });
  await config.flushScope(PERSONAL);
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback), fallback);

  let hydrations = 0;
  const hydrate = async () => {
    hydrations += 1;
    registerOpenRouterCatalogModel({
      id: "testvendor/cold-router-model",
      name: "Cold Router Model",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ["text"],
      reasoning: true,
      cost: { input: 0, output: 0 },
    });
  };
  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate), {
    harnessId: "pi",
    modelId: "testvendor/cold-router-model",
  });
  assert.equal(hydrations, 1);

  assert.deepEqual(
    await resolveRuntimeChoiceDurable(
      config,
      ORG,
      PERSONAL,
      fallback,
      { modelId: "testvendor/cold-router-model" },
      hydrate,
    ),
    { harnessId: "pi", modelId: "testvendor/cold-router-model" },
  );

  const before = hydrations;
  await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate);
  assert.equal(hydrations, before);
});
