import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTurnEffort,
  applyFastSpeed,
  scaleCost,
  FAST_COST_MULTIPLIER,
  modelSupportsFastMode,
  wantsFastMode,
  TURN_PROVIDER_EFFORT_ALIASES,
} from "../src/harness/pi-harness.ts";
import { defaultInteractiveThinkingLevel } from "../src/model/pi-models.ts";

test("modelSupportsFastMode allows only the documented direct Opus ids", () => {
  for (const id of ["claude-opus-5", "claude-opus-4-8"]) {
    assert.equal(modelSupportsFastMode(id), true, `${id} should support fast mode`);
  }
  for (const id of [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",

    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4.8",
    "anthropic/claude-opus-4.8-fast",
    "",
    undefined,
  ]) {
    assert.equal(modelSupportsFastMode(id as string | undefined), false, `${String(id)} must not support fast mode`);
  }
});

test('applyFastSpeed injects service_tier:"priority" for OpenAI-API models', () => {
  const on = { model: "gpt-5.6-sol", input: [] } as Record<string, unknown>;
  applyFastSpeed(on, true, "openai-responses");
  assert.equal(on.service_tier, "priority");
  assert.equal("speed" in on, false, "no Anthropic speed field on an OpenAI request");

  const off = { model: "gpt-5.6-sol", input: [] } as Record<string, unknown>;
  applyFastSpeed(off, false, "openai-responses");
  assert.equal("service_tier" in off, false);
});

test("modelSupportsFastMode covers the GPT-5.6 family (priority tier)", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.equal(modelSupportsFastMode(id), true, id);
  }
});

test("scaleCost doubles OpenAI per-token rates for fast mode", () => {
  const scaled = scaleCost({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, FAST_COST_MULTIPLIER);
  assert.deepEqual(scaled, { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 });
});

test('applyFastSpeed injects speed:"fast" into the body only when fast is requested', () => {
  const on = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  assert.equal(applyFastSpeed(on, true), on, "returns the same object (in-place mutation)");
  assert.equal(on.speed, "fast");

  const off = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  applyFastSpeed(off, false);
  applyFastSpeed(off, undefined);
  assert.equal("speed" in off, false, "no speed field on a non-fast turn");
});

test("applyFastSpeed never throws on non-object payloads", () => {
  assert.doesNotThrow(() => applyFastSpeed(undefined, true));
  assert.doesNotThrow(() => applyFastSpeed(null, true));
  assert.doesNotThrow(() => applyFastSpeed("raw", true));
});

test("TURN_PROVIDER_EFFORT_ALIASES maps web-ui aliases to Anthropic effort values", () => {
  assert.equal(TURN_PROVIDER_EFFORT_ALIASES.max, "max");
  assert.equal(
    TURN_PROVIDER_EFFORT_ALIASES.ultracode,
    "max",
    "Ultracode is a UI alias, not a provider effort enum (#312)",
  );
  assert.equal(TURN_PROVIDER_EFFORT_ALIASES.auto, null, "auto leaves effort to the provider/default path");
});

test("defaultInteractiveThinkingLevel keeps human turns light by provider", () => {
  assert.equal(defaultInteractiveThinkingLevel({ provider: "anthropic", api: "anthropic-messages" }), "low");
  assert.equal(defaultInteractiveThinkingLevel({ provider: "openai", api: "openai-responses" }), "auto");
});

test("fast mode requires an explicit opt-in on a supported model", () => {
  assert.equal(wantsFastMode(undefined, "claude-opus-5"), false);
  assert.equal(wantsFastMode(false, "claude-opus-5"), false);
  assert.equal(wantsFastMode(true, "claude-opus-5"), true);
  assert.equal(wantsFastMode(true, "claude-sonnet-5"), false);
});

test("auto resets a reused Anthropic session to its interactive default", () => {
  const session = {
    state: {
      model: { provider: "anthropic", api: "anthropic-messages" },
      thinkingLevel: "high",
    },
    setThinkingLevel(level: string) {
      this.state.thinkingLevel = level;
    },
  };
  applyTurnEffort(session as never, "auto");
  assert.equal(session.state.thinkingLevel, "low");
});
