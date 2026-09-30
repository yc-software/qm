import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  THINKING_LEVELS,
  modelSupportedByHarness,
  parseRuntimeChoice,
  resolveModel,
  thinkingLevelsForHarness,
} from "../src/model/pi-models.ts";
import { builtInModelCatalog } from "../src/model/model-catalog.ts";
import { codexReasoningEffort } from "../src/harness/codex-harness.ts";
import { applyTurnEffort } from "../src/harness/pi-harness.ts";
import { resolvePinnedRuntime, resolveRuntimeChoice } from "../src/harness/harness-router.ts";
import { createRuntimeService } from "../src/harness/runtime-control.ts";
import { recoveredRuntime } from "../src/harness/runtime-recovery.ts";
import type { SessionEntry } from "../src/types.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { runtimeChoice } from "./support/runtime-choice.ts";

const tiers = (harnessId: "pi" | "claude" | "codex", modelId: string) =>
  thinkingLevelsForHarness(harnessId, modelId).filter((level) => !["auto", "default", "adaptive"].includes(level));
const valid = (harnessId: "pi" | "claude" | "codex", modelId: string) =>
  thinkingLevelsForHarness(harnessId, modelId).join(", ");
const ORG = "org:default-org";
const SCOPE = "personal:alice";

test("each model offers only the effort levels its provider documents", () => {
  assert.deepEqual(tiers("pi", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("pi", "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(tiers("pi", "claude-haiku-4-5"), []);
  assert.deepEqual(thinkingLevelsForHarness("pi", "claude-sonnet-5-5"), [
    "auto",
    "default",
    "adaptive",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(tiers("claude", "claude-sonnet-5-5"), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.deepEqual(tiers("pi", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("claude", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.deepEqual(tiers("claude", "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(tiers("codex", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(tiers("codex", "gpt-6-luna"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("codex", "claude-opus-5-5"), []);
  assert.deepEqual(tiers("claude", "gpt-6-astra"), []);
});

test("pi sends OpenAI max as max instead of clamping it to xhigh", () => {
  for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    assert.equal(clampThinkingLevel(resolveModel(modelId)!, "max"), "max");
  assert.equal(codexReasoningEffort("ultra"), "ultra");
  assert.equal(codexReasoningEffort("ultracode"), undefined);
});

test("the runtime parser rejects any effort the harness and model do not offer, naming the valid levels", () => {
  for (const [harnessId, modelId, effortLevel] of [
    ["codex", "gpt-6-astra", "ultracode"],
    ["codex", "gpt-6-luna", "ultra"],
    ["claude", "claude-opus-4-6", "xhigh"],
    ["claude", "claude-opus-5-5", "ultra"],
    ["pi", "claude-opus-5-5", "ultracode"],
    ["pi", "gpt-6-astra", "ultra"],
    ["pi", "claude-haiku-4-5", "low"],
    ["claude", "claude-haiku-4-5", "high"],
  ] as const)
    assert.deepEqual(parseRuntimeChoice({ harnessId, modelId, effortLevel }), {
      ok: false,
      error: "effort_not_supported",
      message: `effort ${effortLevel} isn't available on ${harnessId}/${modelId} (valid: ${valid(harnessId, modelId)})`,
    });
  assert.equal(parseRuntimeChoice({ harnessId: "claude", modelId: "claude-haiku-4-5", effortLevel: "auto" }).ok, true);
});

test("the runtime tool rejects invalid efforts, including one carried over to a new model", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex"]);
  const service = createRuntimeService({ config, harnessId: "pi" }, { authorizesCapabilityScope: async () => true });
  const claims = { actorId: "alice", scopeId: SCOPE, liveActor: true, exp: Date.now() + 60_000 } as const;
  const onClaude = runtimeChoice({ harnessId: "claude", modelId: "claude-opus-5-5", effortLevel: "ultracode" });
  assert.deepEqual(
    await service(claims, onClaude, { action: "set", harness: "codex", model: "gpt-6-astra", lifetime: "scope" }),
    {
      ok: false,
      error: "effort_not_supported",
      message: `effort ultracode isn't available on codex/gpt-6-astra; choose another effort (valid: ${valid("codex", "gpt-6-astra")})`,
    },
  );
  assert.deepEqual(
    await service(claims, onClaude, { action: "set", harness: "codex", model: "gpt-6-astra", effort: "ultracode" }),
    {
      ok: false,
      error: "effort_not_supported",
      message: `effort ultracode isn't available on codex/gpt-6-astra (valid: ${valid("codex", "gpt-6-astra")})`,
    },
  );
  assert.equal(config.getRuntimeSelection(SCOPE), null);
  const moved = await service(claims, onClaude, {
    action: "set",
    harness: "codex",
    model: "gpt-6-astra",
    effort: "ultra",
    lifetime: "scope",
  });
  assert.equal(moved.ok, true);
  assert.equal(config.getRuntimeSelection(SCOPE)?.effortLevel, "ultra");
});

test("turn and sessions-open overrides reject an effort the target does not offer, explicit or carried", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex"]);
  config.setRuntimeSelection(
    SCOPE,
    runtimeChoice({ harnessId: "claude", modelId: "claude-opus-5-5", effortLevel: "ultracode" }),
  );
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5-5" };
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "ultra" }),
    /effort ultra isn't available on claude\/claude-opus-5-5 \(valid: /,
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { harnessId: "codex", modelId: "gpt-6-astra" }),
    {
      message: `effort ultracode isn't available on codex/gpt-6-astra; choose another effort (valid: ${valid("codex", "gpt-6-astra")})`,
    },
  );
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, SCOPE, fallback, {
      harnessId: "codex",
      modelId: "gpt-6-astra",
      effortLevel: "max",
    }),
    { harnessId: "codex", modelId: "gpt-6-astra", effortLevel: "max" },
  );
});

test("a saved effort the model no longer offers fails the turn by name until an offered effort is saved", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex"]);
  const stale = { harnessId: "pi" as const, modelId: "claude-opus-5-5", effortLevel: "ultracode" };
  config.setRuntimeSelection(SCOPE, stale as ReturnType<typeof runtimeChoice>);
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5-5" };
  assert.throws(() => resolveRuntimeChoice(config, ORG, SCOPE, fallback), {
    message: `effort ultracode isn't available on pi/claude-opus-5-5; choose another effort (valid: ${valid("pi", "claude-opus-5-5")})`,
  });
  const service = createRuntimeService({ config, harnessId: "pi" }, { authorizesCapabilityScope: async () => true });
  const claims = { actorId: "alice", scopeId: SCOPE, liveActor: true, exp: Date.now() + 60_000 } as const;
  const active = { harnessId: "pi" as const, modelId: "claude-opus-5-5" };
  const fixed = await service(claims, active, { action: "set", effort: "xhigh", lifetime: "scope" });
  assert.equal(fixed.ok, true);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback), {
    harnessId: "pi",
    modelId: "claude-opus-5-5",
    effortLevel: "xhigh",
    fastMode: false,
  });
});

test("the web picker, admin settings and cron writers reject an effort the model does not offer", async () => {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "claude", "codex"]);
  await built.config.flushScope(ORG);
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: true, openrouter: false },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const put = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "U1",
        scopeId: "personal:U1",
        harnessId: "codex",
        modelId: "gpt-6-astra",
        effortLevel: "ultracode",
      }),
    });
    assert.equal(put.status, 400);
    assert.deepEqual(await put.json(), {
      error: "effort_not_supported",
      message: `effort ultracode isn't available on codex/gpt-6-astra (valid: ${valid("codex", "gpt-6-astra")})`,
    });
    assert.equal(await built.config.getRuntimeSelectionDurable("personal:U1"), null);
    await assert.rejects(
      built.app.createCron({
        ownerScopeId: "personal:U1",
        owner: "U1",
        createdBy: "U1",
        schedule: { everyMs: 60_000 },
        action: "ping",
        runtime: { harnessId: "pi", modelId: "claude-haiku-4-5", effortLevel: "high" },
      }),
      { message: `effort high isn't available on pi/claude-haiku-4-5 (valid: ${valid("pi", "claude-haiku-4-5")})` },
    );
    assert.deepEqual(await built.app.listCrons(), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a recovered handoff keeps its effort, and resolving it fails when the model no longer offers it", () => {
  const entry = {
    type: "tool_result",
    payload: {
      tool: "runtime",
      runId: "run",
      actorId: "alice",
      runtimeHandoff: { choice: { harnessId: "codex", modelId: "gpt-6-luna", effortLevel: "ultra", fastMode: false } },
    },
  } as unknown as SessionEntry;
  const recovered = recoveredRuntime([entry], "run", "alice");
  assert.deepEqual(recovered, { harnessId: "codex", modelId: "gpt-6-luna", effortLevel: "ultra", fastMode: false });
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex"]);
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, { harnessId: "pi", modelId: "claude-opus-5-5" }, recovered),
    { message: `effort ultra isn't available on codex/gpt-6-luna (valid: ${valid("codex", "gpt-6-luna")})` },
  );
});

test("every selectable effort resolves to exactly itself, and every other level is refused", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex"]);
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5-5" };
  let checked = 0;
  for (const harnessId of ["pi", "claude", "codex"] as const)
    for (const { id: modelId } of builtInModelCatalog().filter(({ id }) => modelSupportedByHarness(id, harnessId))) {
      const offered = thinkingLevelsForHarness(harnessId, modelId);
      for (const level of THINKING_LEVELS) {
        const saved = () => {
          config.setRuntimeSelection(SCOPE, { harnessId, modelId, effortLevel: level } as ReturnType<
            typeof runtimeChoice
          >);
          return resolveRuntimeChoice(config, ORG, SCOPE, fallback);
        };
        const requested = () =>
          resolveRuntimeChoice(config, ORG, SCOPE, fallback, { harnessId, modelId, effortLevel: level });
        for (const resolve of [saved, requested]) {
          checked++;
          if (offered.includes(level)) assert.equal(resolve().effortLevel, level, `${harnessId}/${modelId} ${level}`);
          else assert.throws(resolve, /isn't available on/, `${harnessId}/${modelId} ${level}`);
        }
        if (harnessId === "pi" && offered.includes(level) && !["auto", "default", "adaptive"].includes(level))
          assert.equal(clampThinkingLevel(resolveModel(modelId)!, level as never), level, `pi/${modelId} ${level}`);
        if (harnessId === "codex" && offered.includes(level) && level !== "auto")
          assert.equal(codexReasoningEffort(level), level, `codex/${modelId} ${level}`);
      }
    }
  assert.ok(checked > 200);
});

test("Pi refuses an effort the model does not offer instead of clamping it to a neighbor", () => {
  const session = (modelId: string) => ({
    state: { model: resolveModel(modelId), thinkingLevel: "high" },
    setThinkingLevel(level: string) {
      this.state.thinkingLevel = level;
    },
  });
  const astra = session("gpt-6-astra");
  assert.throws(() => applyTurnEffort(astra as never, "ultracode"), /effort ultracode isn't a Pi effort level/);
  assert.throws(() => applyTurnEffort(astra as never, "ultra"), /effort ultra isn't a Pi effort level/);
  const opus46 = session("claude-opus-4-6");
  assert.throws(() => applyTurnEffort(opus46 as never, "xhigh"), /effort xhigh isn't available on pi\/claude-opus-4-6/);
  assert.equal(astra.state.thinkingLevel, "high");
  assert.equal(opus46.state.thinkingLevel, "high");
  applyTurnEffort(astra as never, "max");
  assert.equal(astra.state.thinkingLevel, "max");
});

test("a personal-account pinned runtime carries the saved effort and fails when the pinned runtime does not offer it", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setRuntimeSelectionLatest(
    SCOPE,
    runtimeChoice({ harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "adaptive" }),
  );
  await assert.rejects(resolvePinnedRuntime(config, ORG, SCOPE, { harnessId: "claude", modelId: "claude-opus-5-5" }), {
    message: `effort adaptive isn't available on claude/claude-opus-5-5; choose another effort (valid: ${valid("claude", "claude-opus-5-5")})`,
  });
  await config.setRuntimeSelectionLatest(
    SCOPE,
    runtimeChoice({ harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "xhigh" }),
  );
  assert.deepEqual(
    await resolvePinnedRuntime(config, ORG, SCOPE, { harnessId: "claude", modelId: "claude-opus-5-5" }),
    {
      harnessId: "claude",
      modelId: "claude-opus-5-5",
      effortLevel: "xhigh",
    },
  );
  assert.deepEqual(
    await resolvePinnedRuntime(config, ORG, SCOPE, {
      harnessId: "claude",
      modelId: "claude-opus-5-5",
      effortLevel: "ultracode",
    }),
    { harnessId: "claude", modelId: "claude-opus-5-5", effortLevel: "ultracode" },
  );
  const pin = { harnessId: "claude", modelId: "claude-opus-5-5" } as const;
  assert.deepEqual(await resolvePinnedRuntime(config, ORG, SCOPE, { ...pin, defaultEffortLevel: "low" }), {
    ...pin,
    effortLevel: "low",
  });
  await config.setRuntimeSelectionLatest(ORG, runtimeChoice({ ...pin, harnessId: "pi", effortLevel: "adaptive" }));
  await config.setRuntimeSelectionLatest(SCOPE, runtimeChoice({ harnessId: "pi", modelId: "claude-opus-5-5" }));
  assert.deepEqual(await resolvePinnedRuntime(config, ORG, SCOPE, pin), pin);
  await config.setRuntimeSelectionLatest(SCOPE, null);
  await assert.rejects(resolvePinnedRuntime(config, ORG, SCOPE, pin), /effort adaptive isn't available on claude/);
  config.setBaseModel(SCOPE, "claude-opus-5-5");
  await config.flushScope(SCOPE);
  assert.deepEqual(await resolvePinnedRuntime(config, ORG, SCOPE, pin), pin);
});
