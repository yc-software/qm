import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { resolveModel, supportedThinkingLevel, thinkingLevelsForHarness } from "../src/model/pi-models.ts";
import { codexReasoningEffort } from "../src/harness/codex-harness.ts";
import { isCronRuntime } from "../src/cron/runtime.ts";

const tiers = (harnessId: "pi" | "claude" | "codex", modelId: string) =>
  thinkingLevelsForHarness(harnessId, modelId).filter((level) => !["auto", "default", "adaptive"].includes(level));

test("each model offers only the effort levels its provider documents", () => {
  assert.deepEqual(tiers("pi", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("pi", "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(tiers("pi", "claude-haiku-4-5"), []);
  assert.deepEqual(tiers("pi", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("claude", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.deepEqual(tiers("claude", "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(tiers("codex", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(tiers("codex", "gpt-6-luna"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("codex", "claude-opus-5-5"), []);
  assert.deepEqual(tiers("claude", "gpt-6-astra"), []);
  for (const harnessId of ["pi", "claude", "codex"] as const)
    for (const modelId of ["claude-opus-5-5", "gpt-6-astra"]) {
      assert.ok(!(harnessId !== "codex" && tiers(harnessId, modelId).includes("ultra")));
      assert.ok(!(harnessId !== "claude" && tiers(harnessId, modelId).includes("ultracode")));
    }
});

test("pi sends OpenAI max as max instead of clamping it to xhigh", () => {
  for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    assert.equal(clampThinkingLevel(resolveModel(modelId)!, "max"), "max");
});

test("saved efforts a model does not offer fall back to the nearest lower level", () => {
  assert.equal(supportedThinkingLevel("pi", "claude-opus-5-5", "ultracode"), "max");
  assert.equal(supportedThinkingLevel("pi", "gpt-6-astra", "ultra"), "max");
  assert.equal(supportedThinkingLevel("claude", "claude-opus-4-6", "xhigh"), "high");
  assert.equal(supportedThinkingLevel("codex", "gpt-6-luna", "ultra"), "max");
  assert.equal(supportedThinkingLevel("codex", "gpt-6-astra", "ultracode"), "ultra");
  assert.equal(supportedThinkingLevel("pi", "claude-haiku-4-5", "high"), undefined);
  assert.equal(supportedThinkingLevel("claude", "claude-opus-5-5", "adaptive"), undefined);
  assert.equal(supportedThinkingLevel("pi", "claude-opus-5-5", "auto"), "auto");
  assert.ok(isCronRuntime({ harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "ultracode" }));
  assert.ok(isCronRuntime({ harnessId: "codex", modelId: "gpt-6-astra", effortLevel: "ultra" }));
  assert.ok(!isCronRuntime({ harnessId: "claude", modelId: "claude-opus-5-5", effortLevel: "adaptive" }));
});

test("Codex receives max and ultra reasoning efforts", () => {
  assert.equal(codexReasoningEffort("max"), "max");
  assert.equal(codexReasoningEffort("ultra"), "ultra");
  assert.equal(codexReasoningEffort("ultracode"), undefined);
});

test("a saved purpose runtime keeps running when its model no longer offers the saved level", async () => {
  const { resolveRuntimeChoice } = await import("../src/harness/harness-router.ts");
  const run = (modelId: string, effortLevel: string) =>
    resolveRuntimeChoice(
      {
        getApprovedHarnesses: () => ["pi"],
        getRuntimeSelection: () => undefined,
        getBaseModel: () => undefined,
        getPurposeRuntime: () => ({ harnessId: "pi", modelId, effortLevel }),
      } as unknown as Parameters<typeof resolveRuntimeChoice>[0],
      "org:test" as Parameters<typeof resolveRuntimeChoice>[1],
      "org:test" as Parameters<typeof resolveRuntimeChoice>[2],
      { harnessId: "pi", modelId: "claude-opus-5-5" },
      undefined,
      "subagent",
    ).effortLevel;
  assert.equal(run("claude-haiku-4-5", "low"), undefined);
  assert.equal(run("claude-opus-5-5", "ultracode"), "max");
  assert.equal(run("gpt-6-astra", "xhigh"), "xhigh");
});
