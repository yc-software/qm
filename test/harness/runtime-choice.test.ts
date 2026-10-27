import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../../src/harness/runtime-choice.ts";
import { createRuntimeService } from "../../src/harness/runtime-control.ts";
import { recoveredRuntime } from "../../src/harness/runtime-recovery.ts";
import { turnModelOptions } from "../../src/core/turn-options.ts";
import type { RuntimeChoice } from "../../src/harness/harness.ts";
import { storedItem } from "../../src/sessions/items.ts";
import { testConfigStore, testDatabaseUrl } from "../support/test-database.ts";
import { availableRuntimeError } from "../../src/api/runtime-config.ts";
import { registerOpenRouterCatalogModel } from "../../src/model/pi-models.ts";

const ORG = "org:default-org";
const SCOPE = "personal:alice";
const fallback: RuntimeChoice = { modelId: "claude-opus-5" };
const category: RuntimeChoice = { modelId: "gpt-6-astra", effortLevel: "low", fastMode: true };

async function setup() {
  const config = testConfigStore();
  await config.setRuntimeSelection(ORG, { ...fallback, effortLevel: "high", fastMode: true });
  await config.setRuntimeSelection(SCOPE, { ...fallback, modelId: "claude-sonnet-5", effortLevel: "medium" });
  return config;
}

test("unset categories preserve legacy conversation, child, and cron behavior", async () => {
  const config = await setup();
  const legacy = resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "subagent"), legacy);
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "cron"),
    resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "xhigh", fastMode: false }),
  );
  assert.deepEqual(turnModelOptions({}), {
    thinkingLevel: "xhigh",
    fastMode: false,
  });
});

test("cron entry points defer legacy injections until runtime resolution", () => {
  assert.deepEqual(turnModelOptions({ surface: "cron" }), {});
  assert.deepEqual(
    turnModelOptions({
      surface: "cron",
      thinkingLevel: "low",
      fastMode: false,
    }),
    {
      thinkingLevel: "low",
      fastMode: false,
    },
  );
});

test("each purpose ignores conversation overrides and explicit fields including false win", async () => {
  const config = await setup();
  const conversation = resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  for (const purpose of ["cron", "subagent", "fallback"] as const) {
    await config.setPurposeRuntime(purpose, category);
    assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, purpose), category);
    assert.deepEqual(
      resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: undefined, fastMode: undefined }, purpose),
      category,
    );
    assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, { fastMode: false }, purpose), {
      ...category,
      fastMode: false,
    });
    assert.deepEqual(
      resolveRuntimeChoice(config, ORG, SCOPE, fallback, { modelId: "gpt-6-sol", effortLevel: "high" }, purpose),
      {
        ...category,
        modelId: "gpt-6-sol",
        effortLevel: "high",
      },
    );
    assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback), conversation);
  }
  await config.clearPurposeRuntime("cron");
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "subagent"), category);
});

test("durable purpose defaults refresh between child followups", async () => {
  const databaseUrl = testDatabaseUrl();
  const writer = testConfigStore({ databaseUrl });
  const reader = testConfigStore({ databaseUrl });
  await writer.setPurposeRuntime("subagent", category);
  assert.deepEqual(
    await resolveRuntimeChoiceDurable(reader, ORG, SCOPE, fallback, undefined, undefined, "subagent"),
    category,
  );
  await writer.setPurposeRuntime("subagent", { ...category, modelId: "gpt-6-sol" });
  assert.deepEqual(
    await resolveRuntimeChoiceDurable(reader, ORG, SCOPE, fallback, { fastMode: false }, undefined, "subagent"),
    {
      ...category,
      modelId: "gpt-6-sol",
      fastMode: false,
    },
  );
});

test("configured purpose fails closed for unapproved or incompatible merged choices", async () => {
  const config = await setup();
  await config.setPurposeRuntime("cron", category);
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "nonsense" }, "cron"),
    /not supported/,
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { modelId: "claude-sonnet-5" }, "cron"),
    /fast mode is not supported/,
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { modelId: "no-such-model" }, "cron"),
    /not approved/,
  );
});

test("runtime get and inherit use job execution defaults, and handoffs survive retries", async () => {
  const config = await setup();
  await config.setPurposeRuntime("cron", category);
  const service = createRuntimeService(
    { config, baseModelDefault: fallback.modelId },
    {
      authorizesCapabilityScope: async () => true,
    },
  );
  const claims = { actorId: "alice", scopeId: SCOPE, exp: Date.now() + 60_000, triggered: true } as const;
  const explicit = { fastMode: false };
  const get = await service(claims, fallback, { action: "get" }, undefined, false, undefined, true, "cron", explicit);
  assert.ok(get.ok);
  assert.deepEqual(get.effective, { ...category, ...explicit });
  const inherit = await service(
    claims,
    fallback,
    { action: "inherit" },
    undefined,
    false,
    undefined,
    true,
    "cron",
    explicit,
  );
  assert.ok(inherit.ok);
  assert.deepEqual(inherit.handoff, { choice: { ...category, ...explicit }, lifetime: "task" });
  const handoff = await service(
    claims,
    { ...category, ...explicit },
    { action: "set", model: "gpt-6-sol" },
    undefined,
    false,
    undefined,
    true,
    "cron",
    explicit,
  );
  assert.ok(handoff.ok && handoff.handoff);
  const run = "00000000-0000-4000-8000-000000000001";
  const entries = [
    storedItem(
      {
        kind: "ToolResult",
        tool: "runtime",
        callId: "c1",
        turnId: run,
        body: { actorId: "alice", runtimeHandoff: handoff.handoff },
      },
      { sessionId: "s", seq: 1, createdAt: 1 },
    ),
  ];
  const restored = recoveredRuntime(entries, run, "alice");
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, restored?.choice, "cron"), {
    ...category,
    ...explicit,
    modelId: "gpt-6-sol",
  });
  assert.equal(recoveredRuntime(entries, "00000000-0000-4000-8000-000000000002", "alice"), undefined);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "cron"), category);
});

test("scope inheritance in a human child continuation retains its configured purpose", async () => {
  const config = await setup();
  await config.setPurposeRuntime("subagent", category);
  const service = createRuntimeService(
    { config, baseModelDefault: fallback.modelId },
    { authorizesCapabilityScope: async () => true },
  );
  const result = await service(
    { actorId: "alice", scopeId: SCOPE, exp: Date.now() + 60_000, liveActor: true },
    category,
    { action: "inherit", lifetime: "scope" },
    undefined,
    false,
    undefined,
    false,
    "subagent",
  );
  assert.ok(result.ok);
  assert.deepEqual(result.handoff, { choice: category, lifetime: "scope" });
  assert.equal(await config.getRuntimeSelectionDurable(SCOPE), null);
});

test("configured categories remain selectable outside the conversation picker without weakening explicit restrictions", async () => {
  const config = await setup();
  await config.setPurposeRuntime("cron", category);
  await config.setSetting("webuiModels", ["claude-sonnet-5"], ORG);
  const service = createRuntimeService(
    { config, baseModelDefault: fallback.modelId },
    { authorizesCapabilityScope: async () => true },
  );
  const claims = { actorId: "alice", scopeId: SCOPE, exp: Date.now() + 60_000, triggered: true } as const;
  const result = await service(claims, category, { action: "inherit" }, undefined, false, undefined, true);
  assert.ok(result.ok);
  assert.deepEqual(result.handoff, { choice: category, lifetime: "task" });
  const denied = await service(
    claims,
    category,
    { action: "set", model: "gpt-6-sol" },
    undefined,
    false,
    undefined,
    true,
  );
  assert.equal(denied.ok, false);
  const settingDurable = config.settingDurable.bind(config);
  config.settingDurable = (async (name, id) =>
    name === "webuiModels" ? [] : settingDurable(name, id)) as typeof config.settingDurable;
  assert.equal((await service(claims, category, { action: "inherit" }, undefined, false, undefined, true)).ok, false);
});

test("personal-account human child inheritance recognizes a configured purpose outside the chat picker", async () => {
  const config = await setup();
  await config.setPurposeRuntime("subagent", category);
  await config.setSetting("webuiModels", ["claude-sonnet-5"], ORG);
  const service = createRuntimeService(
    { config, baseModelDefault: fallback.modelId },
    { authorizesCapabilityScope: async () => true },
  );
  const claims = { actorId: "alice", scopeId: SCOPE, exp: Date.now() + 60_000, liveActor: true } as const;
  const result = await service(
    claims,
    category,
    { action: "inherit" },
    async () => null,
    true,
    undefined,
    false,
    "subagent",
  );
  assert.ok(result.ok);
  assert.deepEqual(result.handoff, { choice: category, lifetime: "task" });
  const denied = await service(
    claims,
    category,
    { action: "inherit" },
    async () => "account denied",
    true,
    undefined,
    false,
    "subagent",
  );
  assert.equal(denied.ok, false);
});

const ORG_SCOPE = "org:default-org" as const;
const PERSONAL = "personal:alice" as const;

test("runtime selection is sparse, revisioned, and acknowledges a changed org default", async () => {
  const config = testConfigStore();
  await config.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "claude-sonnet-5" });

  assert.equal(config.getRuntimeSelection(ORG_SCOPE)?.revision, 1);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  await config.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-opus-4-8" });
  assert.equal(config.getRuntimeSelection(ORG_SCOPE)?.revision, 2);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  await config.acknowledgeRuntimeSelection(PERSONAL);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 2);

  await config.setRuntimeSelection(PERSONAL, null);
  assert.equal(config.getRuntimeSelection(PERSONAL), null);
});

test("runtime resolution uses explicit choice, then scope, then org and rejects unapproved requests", async () => {
  const config = testConfigStore();
  await config.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "gpt-5.5" });
  const fallback = { modelId: "claude-opus-4-8" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG_SCOPE, PERSONAL, fallback), { modelId: "gpt-5.5" });
  assert.deepEqual(resolveRuntimeChoice(config, ORG_SCOPE, PERSONAL, fallback, { modelId: "claude-sonnet-4-6" }), {
    modelId: "claude-sonnet-4-6",
  });
  assert.throws(
    () => resolveRuntimeChoice(config, ORG_SCOPE, PERSONAL, fallback, { modelId: "no-such-model" }),
    /not approved/,
  );
});

test("runtime resolution carries reasoning and fast-mode defaults into turns", async () => {
  const config = testConfigStore();
  await config.setRuntimeSelection(ORG_SCOPE, {
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(resolveRuntimeChoice(config, ORG_SCOPE, PERSONAL, { modelId: "claude-fable-5" }), {
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG_SCOPE,
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
      ORG_SCOPE,
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
  const databaseUrl = testDatabaseUrl();
  const writer = testConfigStore({ databaseUrl });
  const reader = testConfigStore({ databaseUrl });
  const fallback = { modelId: "claude-opus-4-8" };

  await writer.setRuntimeSelection(ORG_SCOPE, fallback);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG_SCOPE, PERSONAL, fallback), fallback);

  await writer.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-sonnet-5" });
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG_SCOPE, PERSONAL, fallback), {
    modelId: "claude-sonnet-5",
  });
});

test("every write that changes a scope's served model notifies listeners", async () => {
  const config = testConfigStore();
  const seen: string[] = [];
  config.onRuntimeSelectionChanged((id) => seen.push(id));

  await config.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-opus-4-8" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "gpt-5.5" });
  await config.setRuntimeSelection(PERSONAL, null);
  await config.acknowledgeRuntimeSelection(PERSONAL);
  assert.deepEqual(seen, [ORG_SCOPE, PERSONAL, PERSONAL]);
});

test("a listener that throws cannot break the write that notified it", async () => {
  const config = testConfigStore();
  config.onRuntimeSelectionChanged(() => {
    throw new Error("surface unreachable");
  });
  await config.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-opus-4-8" });
  assert.equal((await config.getRuntimeSelectionDurable(ORG_SCOPE))?.modelId, "claude-opus-4-8");
});

test("durable runtime resolution hydrates the model catalog before rejecting an unknown dynamic model", async () => {
  const config = testConfigStore();
  await config.setRuntimeSelection(PERSONAL, { modelId: "testvendor/cold-router-model" });
  const fallback = { modelId: "claude-opus-4-8" };

  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG_SCOPE, PERSONAL, fallback), fallback);

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
  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG_SCOPE, PERSONAL, fallback, undefined, hydrate), {
    modelId: "testvendor/cold-router-model",
  });
  assert.equal(hydrations, 1);

  assert.deepEqual(
    await resolveRuntimeChoiceDurable(
      config,
      ORG_SCOPE,
      PERSONAL,
      fallback,
      { modelId: "testvendor/cold-router-model" },
      hydrate,
    ),
    { modelId: "testvendor/cold-router-model" },
  );

  const before = hydrations;
  await resolveRuntimeChoiceDurable(config, ORG_SCOPE, PERSONAL, fallback, undefined, hydrate);
  assert.equal(hydrations, before);
});

test("explicit runtime validation rejects a revoked scoped model and unsupported fast mode", async () => {
  const config = testConfigStore();
  await config.setRuntimeSelection(ORG_SCOPE, { modelId: "claude-sonnet-5" });
  await config.setRuntimeSelection(PERSONAL, { modelId: "gpt-6-astra" });
  await config.setSetting("webuiModels", ["claude-sonnet-5"], ORG_SCOPE);
  const ctx = { deps: { config } };
  assert.match((await availableRuntimeError(ctx, PERSONAL, { modelId: "gpt-6-astra" }))!, /no longer available/);
  assert.equal(
    await availableRuntimeError(ctx, PERSONAL, { modelId: "claude-sonnet-5", fastMode: true }),
    "fast_mode_not_supported",
  );
});
