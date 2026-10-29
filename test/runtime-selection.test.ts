import { availableRuntimeError } from "../src/api/runtime-config.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore, type PersistedBaseModel } from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../src/harness/runtime-choice.ts";
import { registerOpenRouterCatalogModel } from "../src/model/pi-models.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ORG = "org:default-org" as const;
const PERSONAL = "personal:alice" as const;

test("runtime selection is sparse, revisioned, and acknowledges a changed org default", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setRuntimeSelection(ORG, { modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "claude-sonnet-5" });

  assert.equal(config.getRuntimeSelection(ORG)?.revision, 1);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  await config.setRuntimeSelection(ORG, { modelId: "claude-opus-4-8" });
  assert.equal(config.getRuntimeSelection(ORG)?.revision, 2);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  await config.acknowledgeRuntimeSelection(PERSONAL);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 2);

  await config.setRuntimeSelection(PERSONAL, null);
  assert.equal(config.getRuntimeSelection(PERSONAL), null);
});

test("runtime resolution uses explicit choice, then scope, then org and rejects unapproved requests", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setRuntimeSelection(ORG, { modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "gpt-5.5" });
  const fallback = { modelId: "claude-opus-4-8" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), { modelId: "gpt-5.5" });
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { modelId: "claude-sonnet-4-6" }), {
    modelId: "claude-sonnet-4-6",
  });
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { modelId: "no-such-model" }),
    /not approved/,
  );
});

test("runtime resolution carries reasoning and fast-mode defaults into turns", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setRuntimeSelection(ORG, {
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { modelId: "claude-fable-5" }), {
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG,
      PERSONAL,
      { modelId: "claude-fable-5" },
      {
        modelId: "gpt-5.5",
      },
    ),
    {
      modelId: "gpt-5.5",
      effortLevel: "high",
      fastMode: false,
    },
  );
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG,
      PERSONAL,
      { modelId: "claude-fable-5" },
      {
        modelId: "claude-opus-5",
      },
    ),
    { modelId: "claude-opus-5", effortLevel: "high", fastMode: true },
  );
});

test("runtime resolution reads selections from shared durable state on every turn", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const writer = createMemoryConfigStore("default-org", { baseModels });
  const reader = createMemoryConfigStore("default-org", { baseModels });
  const fallback = { modelId: "claude-opus-4-8" };

  await writer.setRuntimeSelection(ORG, fallback);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), fallback);

  await writer.setRuntimeSelection(ORG, { modelId: "claude-sonnet-5" });
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), {
    modelId: "claude-sonnet-5",
  });
});

test("every write that changes a scope's served model notifies listeners", async () => {
  const config = createMemoryConfigStore("default-org");
  const seen: string[] = [];
  config.onRuntimeSelectionChanged((id) => seen.push(id));

  await config.setRuntimeSelection(ORG, { modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "gpt-5.5" });
  await config.setBaseModel(PERSONAL, "gpt-5.6-sol");
  await config.setRuntimeSelection(PERSONAL, null);
  await config.acknowledgeRuntimeSelection(PERSONAL);
  assert.deepEqual(seen, [ORG, PERSONAL, PERSONAL, PERSONAL]);
});

test("a listener that throws cannot break the write that notified it", async () => {
  const config = createMemoryConfigStore("default-org");
  config.onRuntimeSelectionChanged(() => {
    throw new Error("surface unreachable");
  });
  await config.setRuntimeSelection(ORG, { modelId: "claude-opus-4-8" });
  assert.equal((await config.getRuntimeSelectionDurable(ORG))?.modelId, "claude-opus-4-8");
});

test("durable runtime resolution hydrates the model catalog before rejecting an unknown dynamic model", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setRuntimeSelection(PERSONAL, { modelId: "testvendor/cold-router-model" });
  const fallback = { modelId: "claude-opus-4-8" };

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
    { modelId: "testvendor/cold-router-model" },
  );

  const before = hydrations;
  await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate);
  assert.equal(hydrations, before);
});

test("explicit runtime validation rejects a revoked scoped model and unsupported fast mode", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setRuntimeSelection(ORG, { modelId: "claude-sonnet-5" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "gpt-6-astra" });
  await config.setWebuiModels(ORG, ["claude-sonnet-5"]);
  const ctx = { deps: { config } };
  assert.match((await availableRuntimeError(ctx, PERSONAL, { modelId: "gpt-6-astra" }))!, /no longer available/);
  assert.equal(
    await availableRuntimeError(ctx, PERSONAL, { modelId: "claude-sonnet-5", fastMode: true }),
    "fast_mode_not_supported",
  );
});
