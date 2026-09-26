import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore, type PersistedBaseModel } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { createRuntimeService } from "../src/harness/runtime-control.ts";
import { recoveredRuntime } from "../src/harness/runtime-recovery.ts";
import { turnModelOptions } from "../src/core/turn-options.ts";
import type { RuntimeChoice } from "../src/harness/harness.ts";
import type { SessionEntry } from "../src/types.ts";

const ORG = "org:default-org";
const SCOPE = "personal:alice";
const fallback: RuntimeChoice = { harnessId: "pi", modelId: "claude-opus-5" };
const category: RuntimeChoice = { harnessId: "pi", modelId: "gpt-6-astra", effortLevel: "low", fastMode: true };

function setup() {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { ...fallback, effortLevel: "high", fastMode: true });
  config.setRuntimeSelection(SCOPE, { ...fallback, modelId: "claude-sonnet-5", effortLevel: "medium" });
  return config;
}

test("unset categories preserve legacy conversation, child, and cron behavior", () => {
  const config = setup();
  const legacy = resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "subagent"), legacy);
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "cron"),
    resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "xhigh", fastMode: false }),
  );
  assert.deepEqual(turnModelOptions({ triggered: true }), { thinkingLevel: "xhigh", fastMode: false });
});

test("cron and loop entry points defer legacy injections until runtime resolution", () => {
  for (const surface of ["cron", "loop"]) {
    assert.deepEqual(turnModelOptions({ triggered: true, surface }), {});
    assert.deepEqual(turnModelOptions({ triggered: true, surface, thinkingLevel: "low", fastMode: false }), {
      thinkingLevel: "low",
      fastMode: false,
    });
  }
});

test("each purpose ignores conversation overrides and explicit fields including false win", async () => {
  const config = setup();
  const conversation = resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  for (const purpose of ["cron", "subagent"] as const) {
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
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const writer = createMemoryConfigStore("default-org", { baseModels });
  const reader = createMemoryConfigStore("default-org", { baseModels });
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
  const config = setup();
  await config.setPurposeRuntime("cron", category);
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { harnessId: "opencode" }, "cron"),
    /not approved/,
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "nonsense" }, "cron"),
    /not supported/,
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { modelId: "claude-sonnet-5" }, "cron"),
    /fast mode is not supported/,
  );
  config.setApprovedHarnesses(["claude"]);
  assert.throws(() => resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "cron"), /not approved/);
});

test("runtime get and inherit use job execution defaults, and handoffs survive retries", async () => {
  const config = setup();
  await config.flushScope(ORG);
  await config.flushScope(SCOPE);
  await config.setPurposeRuntime("cron", category);
  const service = createRuntimeService(
    { config, harnessId: "pi", baseModelDefault: fallback.modelId },
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
  const entries = [
    {
      type: "tool_result",
      payload: { tool: "runtime", runId: "run", actorId: "alice", runtimeHandoff: handoff.handoff },
    },
  ] as SessionEntry[];
  const restored = recoveredRuntime(entries, "run", "alice");
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, restored, "cron"), {
    ...category,
    ...explicit,
    modelId: "gpt-6-sol",
  });
  assert.equal(recoveredRuntime(entries, "another-run", "alice"), undefined);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, "cron"), category);
});

test("scope inheritance in a human child continuation retains its configured purpose", async () => {
  const config = setup();
  await config.setPurposeRuntime("subagent", category);
  const service = createRuntimeService(
    { config, harnessId: "pi", baseModelDefault: fallback.modelId },
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
  const config = setup();
  await config.setPurposeRuntime("cron", category);
  config.setWebuiModels(ORG, ["claude-sonnet-5"]);
  await config.flushScope(ORG);
  const service = createRuntimeService(
    { config, harnessId: "pi", baseModelDefault: fallback.modelId },
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
  config.getWebuiModelsDurable = async () => [];
  assert.equal((await service(claims, category, { action: "inherit" }, undefined, false, undefined, true)).ok, false);
});

test("personal-account human child inheritance recognizes a configured purpose outside the chat picker", async () => {
  const config = setup();
  await config.setPurposeRuntime("subagent", category);
  config.setWebuiModels(ORG, ["claude-sonnet-5"]);
  await config.flushScope(ORG);
  const service = createRuntimeService(
    { config, harnessId: "pi", baseModelDefault: fallback.modelId },
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
