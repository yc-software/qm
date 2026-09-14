import { applyRuntimeOptions } from "./runtime-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  defaultModelValue,
  getModelOptions,
  getHarnessOptions,
  runtimeModelOptions,
  transcriptModel,
  harnessSupportsEffort,
  harnessSupportsFastMode,
} from "../src/model-options.ts";
import { metadata } from "./model-metadata.ts";

const catalog = { future: metadata("future", "Future API Model"), custom: metadata("custom", "Custom", "gateway") };

test("server metadata controls picker labels, geometry, price, order and effective selection", async () => {
  await applyRuntimeOptions(
    "scope:a",
    ["pi", "mock"],
    { pi: ["custom", "future", "custom"], mock: ["future"] },
    { harnessId: "mock", modelId: "future" },
    catalog,
  );
  assert.deepEqual(
    getModelOptions("scope:a").map((m) => m.value),
    ["pi:custom", "pi:future", "mock:future"],
  );
  assert.equal(defaultModelValue("scope:a"), "mock:future");
  const model = getModelOptions("scope:a")[1]!;
  assert.equal(model.label, "Future API Model");
  assert.equal(model.model.contextWindow, 98765);
  assert.deepEqual(model.model.cost, catalog.future.cost);
  assert.equal(model.model.baseUrl, "");
});

test("empty, unknown, missing-metadata and unapproved lists stay empty", async () => {
  for (const options of [
    runtimeModelOptions([], { pi: ["future"] }, catalog),
    runtimeModelOptions(["pi"], { pi: [] }, catalog),
    runtimeModelOptions(["pi"], { pi: ["future"] }),
    runtimeModelOptions(["pi"], { pi: ["unknown"] }, catalog),
  ])
    assert.deepEqual(options, []);
  await applyRuntimeOptions("scope:empty", ["pi"], { pi: [] }, { harnessId: "pi", modelId: "future" }, catalog);
  assert.deepEqual(getModelOptions("scope:empty"), []);
  assert.equal(defaultModelValue("scope:empty"), "pi:future");
  assert.equal(transcriptModel("scope:empty"), undefined);
  assert.deepEqual(getHarnessOptions("scope:empty"), []);
});

test("scopes retain independent choices and an unloaded scope does not borrow another policy", async () => {
  await applyRuntimeOptions("scope:a", ["pi"], { pi: ["future"] }, { harnessId: "pi", modelId: "future" }, catalog);
  await applyRuntimeOptions(
    "scope:b",
    ["mock"],
    { mock: ["custom"] },
    { harnessId: "mock", modelId: "custom" },
    catalog,
  );
  assert.equal(defaultModelValue("scope:a"), "pi:future");
  assert.equal(defaultModelValue("scope:b"), "mock:custom");
  assert.deepEqual(getModelOptions("scope:new"), []);
});

test("OpenRouter and custom provider metadata retains provider grouping", async () => {
  const models = { "vendor/new": metadata("vendor/new", "Vendor: New", "openrouter"), custom: catalog.custom };
  const options = runtimeModelOptions(["pi"], { pi: Object.keys(models) }, models);
  assert.deepEqual(
    options.map((m) => m.groupLabel),
    ["Vendor", "Gateway"],
  );
});

test("picker has no model IDs, clone templates or runtime SDK model registry imports", async () => {
  const source = ["pi-models.ts", "model-options.ts"]
    .map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /MODEL_CATALOG|CLONE_TEMPLATES|gpt-5|claude-opus|openrouter\/auto|import \{ getModel/);
});

test("harness controls retain their supported surfaces", async () => {
  assert.equal(harnessSupportsEffort("pi"), true);
  assert.equal(harnessSupportsEffort("opencode"), false);
  assert.equal(harnessSupportsFastMode("claude"), true);
  assert.equal(harnessSupportsFastMode("codex"), true);
});

test("deleted selection retains identity and transcript rendering does not borrow a replacement", async () => {
  await applyRuntimeOptions(
    "scope:deleted",
    ["pi"],
    { pi: ["custom"] },
    { harnessId: "pi", modelId: "future" },
    catalog,
  );
  assert.equal(defaultModelValue("scope:deleted"), "pi:future");
  assert.equal(transcriptModel("scope:deleted"), undefined);
  assert.deepEqual(
    getModelOptions("scope:deleted").map((model) => model.value),
    ["pi:custom"],
  );
  await applyRuntimeOptions(
    "scope:deleted",
    ["pi"],
    { pi: ["custom"] },
    { harnessId: "pi", modelId: "custom" },
    catalog,
  );
  assert.equal(defaultModelValue("scope:deleted"), "pi:custom");
  assert.equal(transcriptModel("scope:deleted")?.id, "custom");
});

test("gateway choices display model names and brands without changing serving identity", () => {
  const cases = [
    ["anthropic/claude-sonnet-5", "Sonnet 5", "anthropic", "Anthropic"],
    ["anthropic/claude-fable-5-1", "Fable 5.1", "anthropic", "Anthropic"],
    ["openai/gpt-6-astra", "GPT-6 Astra", "openai", "OpenAI"],
    ["openai/gpt-5.6-terra", "GPT-5.6 Terra", "openai", "OpenAI"],
    ["openai/gpt-5.6-1", "GPT-5.6 1", "openai", "OpenAI"],
    ["gemini/gemini-3.8-flash", "Gemini 3.8 Flash", "google", "Google"],
  ];
  for (const [route, label, provider, group] of cases) {
    const id = `gateway/${route}`;
    const data = metadata(id!, route!, "qm:gateway");
    const [option] = runtimeModelOptions(["pi"], { pi: [id] }, { [id]: data });
    assert.equal(option?.label, label);
    assert.equal(option?.buttonLabel, label);
    assert.equal(option?.displayProvider, provider);
    assert.equal(option?.groupLabel, group);
    assert.equal(option?.value, `pi:${id}`);
    assert.equal(option?.model.provider, "qm:gateway");
    assert.equal(option?.model.id, id);
    assert.deepEqual(option?.model.cost, data.cost);
  }
});

test("gateway display preserves explicit labels and leaves unknown families alone", () => {
  const id = "gateway/anthropic/claude-sonnet-5";
  const custom = { ...metadata(id, "Writing model", "qm:gateway"), buttonLabel: "Writer" };
  const unknownId = "gateway/vendor/special-model";
  const unknown = metadata(unknownId, "Special", "qm:gateway");
  const [knownOption, unknownOption] = runtimeModelOptions(
    ["pi"],
    { pi: [id, unknownId] },
    { [id]: custom, [unknownId]: unknown },
  );
  assert.equal(knownOption?.label, "Writing model");
  assert.equal(knownOption?.buttonLabel, "Writer");
  assert.equal(knownOption?.displayProvider, "anthropic");
  assert.equal(unknownOption?.label, "Special");
  assert.equal(unknownOption?.displayProvider, undefined);
});
