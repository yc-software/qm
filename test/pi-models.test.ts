import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auxiliaryModelFor,
  auxiliaryModelForProvider,
  defaultModelForHarness,
  defaultModelForProvider,
  modelServiceable,
  modelSupportedByHarness,
  onlyProvider,
  resolveModel,
  getRequiredModel,
  MODEL_PROVIDERS,
  SELECTABLE_BASE_MODELS,
  contextTokenBudgetForModel,
} from "../src/model/pi-models.ts";

test("every selectable base model resolves against the pi-ai registry", () => {
  for (const m of SELECTABLE_BASE_MODELS) {
    const model = getRequiredModel(m.id);
    assert.equal(model.id, m.id);
    assert.ok(
      ["anthropic", "openai", "openrouter"].includes(String(model.provider)),
      `${m.id} has unexpected provider ${model.provider}`,
    );
  }
});

test("selectable models span providers (multi-provider is wired)", () => {
  const providers = new Set(SELECTABLE_BASE_MODELS.map((m) => getRequiredModel(m.id).provider));
  assert.ok(providers.has("anthropic"), "expected at least one Anthropic model");
  assert.ok(providers.has("openai"), "expected at least one OpenAI model (gpt-5.6)");
  assert.ok(providers.has("openrouter"), "expected an OpenRouter-hosted open-model option");
});

test("unknown models are not silently accepted", () => {
  assert.equal(resolveModel("claude-not-a-real-model"), undefined);
  assert.throws(() => getRequiredModel("claude-not-a-real-model"), /Unsupported model/);
});

test("native harnesses reject cross-provider pins and choose their own defaults", () => {
  assert.equal(modelSupportedByHarness("claude-opus-4-8", "claude"), true);
  assert.equal(modelSupportedByHarness("gpt-5.6-sol", "claude"), false);
  assert.equal(modelSupportedByHarness("gpt-5.6-sol", "codex"), true);
  assert.equal(modelSupportedByHarness("claude-opus-4-8", "codex"), false);
  assert.equal(modelSupportedByHarness("claude-future-9", "claude"), true);
  assert.equal(modelSupportedByHarness("gpt-future-9", "codex"), true);
  assert.equal(defaultModelForHarness("codex", "claude-opus-4-8"), "gpt-5.6-sol");
});

test("the default base model follows the providers a deployment can actually bill", () => {
  for (const provider of MODEL_PROVIDERS) {
    const only = onlyProvider(provider);
    const chosen = defaultModelForHarness("pi", undefined, only);
    assert.equal(
      modelServiceable(chosen, only),
      true,
      `a ${provider}-only deployment must default to a model ${provider} can serve, got ${chosen}`,
    );
  }
  assert.equal(defaultModelForHarness("pi", undefined, onlyProvider("openrouter")), "openrouter/auto");
  assert.equal(defaultModelForHarness("pi", undefined, onlyProvider("openai")), "gpt-5.6-sol");
});

test("provider-blind callers and explicit pins keep the shipped default", () => {
  assert.equal(defaultModelForHarness("pi"), "claude-opus-5");
  assert.equal(defaultModelForHarness("pi", undefined, onlyProvider("anthropic")), "claude-opus-5");
  assert.equal(
    defaultModelForHarness("pi", "claude-sonnet-5", onlyProvider("openrouter")),
    "claude-sonnet-5",
    "an explicit pin is never silently swapped — the mismatch is rejected at config load instead",
  );
  assert.equal(
    defaultModelForHarness("pi", undefined, { anthropic: false, openai: false, openrouter: false }),
    "claude-opus-5",
    "with no provider at all the shipped default stands rather than an arbitrary pick",
  );
});

test("a provider that cannot serve a harness has no default model for it", () => {
  assert.equal(defaultModelForProvider("pi", "openrouter"), "openrouter/auto");
  assert.equal(defaultModelForProvider("codex", "openai"), "gpt-5.6-sol");
  assert.equal(defaultModelForProvider("claude", "anthropic"), "claude-opus-5");
  assert.equal(defaultModelForProvider("codex", "anthropic"), undefined, "the Codex CLI runs no Anthropic model");
  assert.equal(defaultModelForProvider("claude", "openrouter"), undefined, "the Claude CLI runs no OpenRouter model");
  assert.equal(defaultModelForProvider("opencode", "openrouter"), undefined, "opencode has no OpenRouter route");
});

test("the curated catalog contains only current model families", () => {
  assert.deepEqual(
    SELECTABLE_BASE_MODELS.map((model) => model.id),
    [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "openrouter/auto",
    ],
  );
  assert.equal(getRequiredModel("gpt-5.6-sol").contextWindow, 1_050_000);
});

test("auxiliary models come from the configured base model's own provider", () => {
  assert.equal(
    auxiliaryModelFor("claude-opus-5"),
    "claude-haiku-4-5",
    "the deployment default resolves an Anthropic auxiliary",
  );
  assert.equal(auxiliaryModelFor("claude-opus-4-8"), "claude-haiku-4-5");
  assert.equal(auxiliaryModelFor("claude-fable-5"), "claude-haiku-4-5");
  assert.equal(
    auxiliaryModelFor("gpt-5.6-sol"),
    "gpt-5.6-luna",
    "an OpenAI deployment gets an OpenAI auxiliary, never Haiku",
  );
  assert.equal(auxiliaryModelFor("gpt-5.6-terra"), "gpt-5.6-luna");
});

test("the Anthropic auxiliary is resolvable by provider, so Anthropic-only surfaces keep working", () => {
  assert.equal(auxiliaryModelForProvider("anthropic"), "claude-haiku-4-5");
  assert.equal(auxiliaryModelForProvider("openai"), "gpt-5.6-luna");
  assert.equal(auxiliaryModelForProvider("nope"), undefined);
});

test("auxiliary selection falls back to the base model when its provider has no cheaper sibling", () => {
  assert.equal(
    auxiliaryModelFor("openrouter/auto"),
    "openrouter/auto",
    "the only OpenRouter entry is its own auxiliary",
  );
  assert.equal(
    auxiliaryModelFor("claude-not-a-real-model"),
    "claude-not-a-real-model",
    "an unresolvable base is returned untouched",
  );
});

test("an auxiliary is never less serviceable than the base model it was derived from", () => {
  const providerSets = [
    { anthropic: true, openai: false, openrouter: false },
    { anthropic: false, openai: true, openrouter: false },
    { anthropic: false, openai: false, openrouter: true },
    { anthropic: false, openai: false, openrouter: false },
  ];
  for (const m of SELECTABLE_BASE_MODELS) {
    const auxiliary = auxiliaryModelFor(m.id);
    assert.equal(
      getRequiredModel(auxiliary).provider,
      getRequiredModel(m.id).provider,
      `${m.id} resolved a cross-provider auxiliary (${auxiliary})`,
    );
    for (const providers of providerSets) {
      assert.equal(
        modelServiceable(auxiliary, providers),
        modelServiceable(m.id, providers),
        `${m.id} -> ${auxiliary} changed serviceability under ${JSON.stringify(providers)}`,
      );
    }
  }
});

test("context token budget is half of each model's real input room", () => {
  assert.equal(getRequiredModel("claude-fable-5").contextWindow, 1_000_000);
  assert.equal(contextTokenBudgetForModel("claude-fable-5"), Math.floor((1_000_000 - 128_000) * 0.5));
  const sol = contextTokenBudgetForModel("gpt-5.6-sol");
  assert.equal(sol, Math.floor((1_050_000 - 128_000) * 0.5));
  assert.ok(sol !== undefined && sol < 1_050_000 * 0.5, "budget stays below half the window");
  assert.equal(contextTokenBudgetForModel("claude-not-a-real-model"), undefined);
  for (const m of SELECTABLE_BASE_MODELS) {
    const budget = contextTokenBudgetForModel(m.id);
    assert.ok(budget !== undefined && budget >= 60_000, `${m.id} budget ${budget} suspiciously small`);
  }
});
