import { test } from "node:test";
import assert from "node:assert/strict";
import { getBaseModel, modelSupportsFastMode, setFastModeModelIds } from "../src/pi-models.ts";

test("web UI resolves models from the shared catalog without privileging a provider", () => {
  const anthropic = getBaseModel("claude-opus-4-8");
  assert.equal(anthropic.id, "claude-opus-4-8");
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(anthropic.api, "anthropic-messages");

  const openai = getBaseModel("gpt-5.6-sol");
  assert.equal(openai.id, "gpt-5.6-sol");
  assert.equal(openai.provider, "openai");

  const openrouter = getBaseModel("openrouter/auto");
  assert.equal(openrouter.provider, "openrouter");

  assert.throws(() => getBaseModel("claude-not-real"), /Unsupported/);
});

test("models this pi-ai build lacks are cloned from a template of their own provider", () => {
  const fable = getBaseModel("claude-fable-5");
  assert.equal(fable.id, "claude-fable-5");
  assert.equal(fable.name, "Claude Fable 5");
  assert.equal(fable.provider, "anthropic");

  const sol = getBaseModel("gpt-5.6-sol");
  assert.equal(sol.id, "gpt-5.6-sol");
  assert.equal(sol.name, "GPT-5.6 Sol");
  assert.equal(sol.provider, "openai", "an OpenAI model never resolves through an Anthropic template");
});

test("fast-mode support is fed from core's runtime config, not a hardcoded client copy", () => {
  setFastModeModelIds(null, []);
  assert.equal(modelSupportsFastMode(null, "claude-opus-4-8"), false);

  setFastModeModelIds(null, ["claude-opus-4-8", "claude-opus-4-7"]);
  assert.equal(modelSupportsFastMode(null, "claude-opus-4-8"), true);
  assert.equal(modelSupportsFastMode(null, "claude-sonnet-4-6"), false);
  assert.equal(modelSupportsFastMode(null, "claude-haiku-4-5"), false);
  assert.equal(modelSupportsFastMode(null, undefined), false);
});

test("a custom-provider model builds from its dynamic catalog entry", () => {
  const custom = getBaseModel("acme-large", { name: "Acme Large", provider: "acme-gateway" });
  assert.equal(custom.id, "acme-large");
  assert.equal(custom.name, "Acme Large");
  assert.equal(custom.provider, "acme-gateway");
});
