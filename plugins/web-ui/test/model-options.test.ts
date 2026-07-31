import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPickerModelIds,
  applyRuntimeOptions,
  defaultModelValue,
  getHarnessOptions,
  getModelOptions,
  getModelOptionsForHarness,
  harnessSupportsEffort,
  harnessSupportsFastMode,
  runtimeModelOptions,
} from "../src/model-options.ts";
import { modelSupportsFastMode, setFastModeModelIds } from "../src/pi-models.ts";

test("the built-in picker includes Fable alongside Opus/Sonnet/Haiku", () => {
  applyPickerModelIds(null);
  const values = getModelOptions().map((o) => o.value);
  assert.deepEqual(values, [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ]);
});

test("the org base model is the default selection when it's an available option", () => {
  applyPickerModelIds(null, "claude-fable-5");
  assert.equal(defaultModelValue(), "claude-fable-5");
  applyPickerModelIds(["claude-opus-4-8", "claude-sonnet-5"], "claude-sonnet-5");
  assert.equal(defaultModelValue(), "claude-sonnet-5");
});

test("without a base model (or one outside the picker) the first option is the default", () => {
  applyPickerModelIds(null);
  assert.equal(defaultModelValue(), "claude-fable-5");
  applyPickerModelIds(["claude-sonnet-5", "claude-haiku-4-5"], "claude-fable-5");
  assert.equal(defaultModelValue(), "claude-sonnet-5");
  applyPickerModelIds(null, "not-a-real-model");
  assert.equal(defaultModelValue(), "claude-fable-5");
});

test("an admin-configured list filters and orders the picker", () => {
  applyPickerModelIds(["claude-fable-5", "claude-sonnet-5"]);
  const values = getModelOptions().map((o) => o.value);
  assert.deepEqual(values, ["claude-fable-5", "claude-sonnet-5"]);
});

test("the Codex picker can render and select the OpenAI model", () => {
  applyPickerModelIds(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], "gpt-5.6-terra");
  assert.deepEqual(
    getModelOptions().map((o) => o.value),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.equal(defaultModelValue(), "gpt-5.6-terra");
});

test("runtime options qualify harness/model pairs and select the effective pair", () => {
  applyRuntimeOptions(
    null,
    ["pi", "codex"],
    { pi: ["claude-opus-4-8"], codex: ["gpt-5.6-sol"] },
    { harnessId: "codex", modelId: "gpt-5.6-sol" },
  );
  assert.deepEqual(
    getModelOptions().map((o) => [o.value, o.harnessId]),
    [
      ["pi:claude-opus-4-8", "pi"],
      ["codex:gpt-5.6-sol", "codex"],
    ],
  );
  assert.equal(defaultModelValue(), "codex:gpt-5.6-sol");
  assert.deepEqual(getHarnessOptions(), [
    { value: "pi", label: "Pi" },
    { value: "codex", label: "Codex" },
  ]);
  assert.deepEqual(
    getModelOptionsForHarness("codex").map((o) => o.label),
    ["GPT-5.6 Sol"],
  );
});

test("runtime options preserve a fetched OpenRouter model as the selected web turn model", () => {
  applyRuntimeOptions(
    null,
    ["pi"],
    { pi: ["anthropic/claude-sonnet-4.5"] },
    { harnessId: "pi", modelId: "anthropic/claude-sonnet-4.5" },
    { "anthropic/claude-sonnet-4.5": { name: "Anthropic: Claude Sonnet 4.5", provider: "openrouter" } },
  );
  const option = getModelOptions()[0]!;
  assert.equal(option.value, "pi:anthropic/claude-sonnet-4.5");
  assert.equal(option.model.id, "anthropic/claude-sonnet-4.5");
  assert.equal(option.model.provider, "openrouter");
  assert.equal(defaultModelValue(), "pi:anthropic/claude-sonnet-4.5");
});

test("runtime options hide retired persisted model ids", () => {
  applyRuntimeOptions(
    null,
    ["claude", "codex"],
    {
      claude: ["claude-fable-5", "claude-sonnet-4-6", "claude-sonnet-5"],
      codex: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    },
    { harnessId: "claude", modelId: "claude-fable-5" },
  );
  assert.deepEqual(
    getModelOptionsForHarness("claude").map((o) => o.label),
    ["Fable 5", "Sonnet 5"],
  );
  assert.deepEqual(
    getModelOptionsForHarness("codex").map((o) => o.label),
    ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"],
  );
});

test("harness-only turn controls are exposed only where the adapter supports them", () => {
  assert.equal(harnessSupportsEffort("pi"), true);
  assert.equal(harnessSupportsEffort("codex"), true);
  assert.equal(harnessSupportsEffort("claude"), true);
  assert.equal(harnessSupportsEffort("opencode"), false);
  assert.equal(harnessSupportsFastMode("pi"), true);
  assert.equal(harnessSupportsFastMode("claude"), true);
  assert.equal(harnessSupportsFastMode("codex"), false);
  assert.equal(harnessSupportsFastMode("opencode"), false);
});

test("an all-retired list falls back within the approved harness", () => {
  applyRuntimeOptions(null, ["codex"], { codex: ["gpt-5.5"] }, { harnessId: "codex", modelId: "gpt-5.5" });
  assert.deepEqual(getHarnessOptions(), [{ value: "codex", label: "Codex" }]);
  assert.deepEqual(
    getModelOptionsForHarness("codex").map((o) => o.label),
    ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"],
  );
  assert.equal(defaultModelValue(), "codex:gpt-5.6-sol");
});

test("unknown ids are dropped; an all-unknown list falls back to the built-in set", () => {
  applyPickerModelIds(["claude-fable-5", "not-a-real-model"]);
  assert.deepEqual(
    getModelOptions().map((o) => o.value),
    ["claude-fable-5"],
  );
  applyPickerModelIds(["nope-1", "nope-2"]);
  assert.deepEqual(
    getModelOptions().map((o) => o.value),
    ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  );
});

test("duplicate ids are de-duped, preserving first occurrence order", () => {
  applyPickerModelIds(["claude-sonnet-5", "claude-sonnet-5", "claude-opus-4-8"]);
  assert.deepEqual(
    getModelOptions().map((o) => o.value),
    ["claude-sonnet-5", "claude-opus-4-8"],
  );
  applyPickerModelIds(null);
});

test("two panes on different scopes keep their own picker, default, and fast-mode set", () => {
  applyRuntimeOptions("personal:me", ["pi"], { pi: ["claude-opus-5"] }, { harnessId: "pi", modelId: "claude-opus-5" });
  setFastModeModelIds("personal:me", ["claude-opus-5"]);
  applyRuntimeOptions(
    "group:team",
    ["codex"],
    { codex: ["gpt-5.6-sol"] },
    { harnessId: "codex", modelId: "gpt-5.6-sol" },
  );
  setFastModeModelIds("group:team", []);

  assert.equal(
    defaultModelValue("personal:me"),
    "pi:claude-opus-5",
    "the later scope must not capture the earlier one",
  );
  assert.equal(defaultModelValue("group:team"), "codex:gpt-5.6-sol");
  assert.deepEqual(
    getModelOptions("personal:me").map((o) => o.value),
    ["pi:claude-opus-5"],
  );
  assert.equal(modelSupportsFastMode("personal:me", "claude-opus-5"), true);
  assert.equal(modelSupportsFastMode("group:team", "claude-opus-5"), false);
});

test("a scope's own model list is derived without disturbing the active picker", () => {
  applyPickerModelIds(["claude-opus-4-8"], "claude-opus-4-8");
  const scoped = runtimeModelOptions(["pi", "codex"], { pi: ["claude-sonnet-5"], codex: ["gpt-5.6-sol"] });
  assert.deepEqual(
    scoped.map((o) => o.value),
    ["pi:claude-sonnet-5", "codex:gpt-5.6-sol"],
  );
  assert.deepEqual(
    getModelOptions().map((o) => o.value),
    ["claude-opus-4-8"],
    "reading a scope's options never re-points the composer's picker",
  );
});
