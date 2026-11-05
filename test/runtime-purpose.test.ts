import test from "node:test";
import assert from "node:assert/strict";
import { type PersistedBaseModel } from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice } from "../src/agent/runtime-choice.ts";
import { createRuntimeService } from "../src/agent/runtime-control.ts";
import { recoveredRuntime } from "../src/agent/runtime-recovery.ts";
import { turnModelOptions } from "../src/agent/runtime-choice.ts";
import type { RuntimeChoice } from "../src/agent/agent.ts";
import { randomUUID } from "node:crypto";
import { storedItem } from "../src/sessions/items.ts";
import { testConfigStore, testMap } from "./support/test-database.ts";

const ORG = "org:default-org";
const SCOPE = "personal:alice";
const fallback: RuntimeChoice = { modelId: "claude-opus-5" };
const category: RuntimeChoice = { modelId: "gpt-6-astra", effortLevel: "low", fastMode: true };

async function setup() {
  const config = testConfigStore("default-org");
  await config.setRuntimeSelection(ORG, { ...fallback, effortLevel: "high", fastMode: true });
  await config.setRuntimeSelection(SCOPE, { ...fallback, modelId: "claude-sonnet-5", effortLevel: "medium" });
  return config;
}

test("unset categories preserve legacy conversation, child, and cron behavior", async () => {
  const config = await setup();
  const legacy = await resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  assert.deepEqual(await resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, undefined, "subagent"), legacy);
  assert.deepEqual(
    await resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, undefined, "cron"),
    await resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "xhigh", fastMode: false }),
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
  const config = await setup();
  const conversation = await resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  for (const purpose of ["cron", "subagent", "fallback"] as const) {
    await config.setPurposeRuntime(purpose, category);
    assert.deepEqual(await resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, undefined, purpose), category);
    assert.deepEqual(
      await resolveRuntimeChoice(
        config,
        ORG,
        SCOPE,
        fallback,
        { effortLevel: undefined, fastMode: undefined },
        undefined,
        purpose,
      ),
      category,
    );
    assert.deepEqual(
      await resolveRuntimeChoice(config, ORG, SCOPE, fallback, { fastMode: false }, undefined, purpose),
      {
        ...category,
        fastMode: false,
      },
    );
    assert.deepEqual(
      await resolveRuntimeChoice(
        config,
        ORG,
        SCOPE,
        fallback,
        { modelId: "gpt-6-sol", effortLevel: "high" },
        undefined,
        purpose,
      ),
      {
        ...category,
        modelId: "gpt-6-sol",
        effortLevel: "high",
      },
    );
    assert.deepEqual(await resolveRuntimeChoice(config, ORG, SCOPE, fallback), conversation);
  }
  await config.clearPurposeRuntime("cron");
  assert.deepEqual(
    await resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, undefined, "subagent"),
    category,
  );
});

test("durable purpose defaults refresh between child followups", async () => {
  const baseModels = testMap<PersistedBaseModel>();
  const writer = testConfigStore("default-org", { baseModels });
  const reader = testConfigStore("default-org", { baseModels });
  await writer.setPurposeRuntime("subagent", category);
  assert.deepEqual(
    await resolveRuntimeChoice(reader, ORG, SCOPE, fallback, undefined, undefined, "subagent"),
    category,
  );
  await writer.setPurposeRuntime("subagent", { ...category, modelId: "gpt-6-sol" });
  assert.deepEqual(
    await resolveRuntimeChoice(reader, ORG, SCOPE, fallback, { fastMode: false }, undefined, "subagent"),
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
  await assert.rejects(
    async () =>
      await resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "nonsense" }, undefined, "cron"),
    /not supported/,
  );
  await assert.rejects(
    async () =>
      await resolveRuntimeChoice(config, ORG, SCOPE, fallback, { modelId: "claude-sonnet-5" }, undefined, "cron"),
    /fast mode is not supported/,
  );
  await assert.rejects(
    async () =>
      await resolveRuntimeChoice(config, ORG, SCOPE, fallback, { modelId: "no-such-model" }, undefined, "cron"),
    /not approved/,
  );
});

test("runtime get uses job execution defaults, and handoffs survive retries", async () => {
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
  const run = randomUUID();
  const items = [
    storedItem(
      {
        kind: "ToolResult",
        tool: "runtime",
        callId: "c",
        body: { actorId: "alice", runtimeHandoff: handoff.handoff },
      },
      { sessionId: "s", seq: 1, createdAt: 1, turnId: run },
    ),
  ];
  const restored = recoveredRuntime(items, run, "alice");
  assert.deepEqual(await resolveRuntimeChoice(config, ORG, SCOPE, fallback, restored?.choice, undefined, "cron"), {
    ...category,
    ...explicit,
    modelId: "gpt-6-sol",
  });
  assert.equal(recoveredRuntime(items, randomUUID(), "alice"), undefined);
  assert.deepEqual(await resolveRuntimeChoice(config, ORG, SCOPE, fallback, undefined, undefined, "cron"), category);
});

test("explicit choices outside the conversation picker stay restricted for configured categories", async () => {
  const config = await setup();
  await config.setPurposeRuntime("cron", category);
  await config.setWebuiModels(ORG, ["claude-sonnet-5"]);
  const service = createRuntimeService(
    { config, baseModelDefault: fallback.modelId },
    { authorizesCapabilityScope: async () => true },
  );
  const claims = { actorId: "alice", scopeId: SCOPE, exp: Date.now() + 60_000, triggered: true } as const;
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
});
