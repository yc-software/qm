import { applyRuntimeOptions } from "./runtime-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultModelValue, getModelOptions, runtimeModelOptions, transcriptModel } from "../src/model-options.ts";
import { metadata } from "./model-metadata.ts";

const catalog = { future: metadata("future", "Future API Model"), custom: metadata("custom", "Custom", "gateway") };

test("server metadata controls picker labels, geometry, price, order and effective selection", async () => {
  await applyRuntimeOptions("scope:a", ["custom", "future", "custom"], { modelId: "future" }, catalog);
  assert.deepEqual(
    getModelOptions("scope:a").map((m) => m.value),
    ["custom", "future"],
  );
  assert.equal(defaultModelValue("scope:a"), "future");
  const model = getModelOptions("scope:a")[1]!;
  assert.equal(model.label, "Future API Model");
  assert.equal(model.model.contextWindow, 98765);
  assert.deepEqual(model.model.cost, catalog.future.cost);
  assert.equal(model.model.baseUrl, "");
});

test("empty, unknown and missing-metadata lists stay empty", async () => {
  for (const options of [
    runtimeModelOptions([], catalog),
    runtimeModelOptions(["future"]),
    runtimeModelOptions(["unknown"], catalog),
  ])
    assert.deepEqual(options, []);
  await applyRuntimeOptions("scope:empty", [], { modelId: "future" }, catalog);
  assert.deepEqual(getModelOptions("scope:empty"), []);
  assert.equal(defaultModelValue("scope:empty"), "future");
  assert.equal(transcriptModel("scope:empty"), undefined);
});

test("scopes retain independent choices and an unloaded scope does not borrow another policy", async () => {
  await applyRuntimeOptions("scope:a", ["future"], { modelId: "future" }, catalog);
  await applyRuntimeOptions("scope:b", ["custom"], { modelId: "custom" }, catalog);
  assert.equal(defaultModelValue("scope:a"), "future");
  assert.equal(defaultModelValue("scope:b"), "custom");
  assert.deepEqual(getModelOptions("scope:new"), []);
});

test("OpenRouter and custom provider metadata retains provider grouping", async () => {
  const models = { "vendor/new": metadata("vendor/new", "Vendor: New", "openrouter"), custom: catalog.custom };
  const options = runtimeModelOptions(Object.keys(models), models);
  assert.deepEqual(
    options.map((m) => m.groupLabel),
    ["Vendor", "Gateway"],
  );
});

test("deleted selection retains identity and transcript rendering does not borrow a replacement", async () => {
  await applyRuntimeOptions("scope:deleted", ["custom"], { modelId: "future" }, catalog);
  assert.equal(defaultModelValue("scope:deleted"), "future");
  assert.equal(transcriptModel("scope:deleted"), undefined);
  assert.deepEqual(
    getModelOptions("scope:deleted").map((model) => model.value),
    ["custom"],
  );
  await applyRuntimeOptions("scope:deleted", ["custom"], { modelId: "custom" }, catalog);
  assert.equal(defaultModelValue("scope:deleted"), "custom");
  assert.equal(transcriptModel("scope:deleted")?.id, "custom");
});

test("gateway choices group under the brand the server names without changing serving identity", () => {
  const id = "gateway/anthropic/claude-sonnet-5";
  const data = {
    ...metadata(id, "anthropic/claude-sonnet-5", "qm:gateway"),
    displayLabel: "Sonnet 5",
    displayProvider: "anthropic",
  };
  const unknownId = "gateway/vendor/special-model";
  const [option, unknown] = runtimeModelOptions([id, unknownId], {
    [id]: data,
    [unknownId]: metadata(unknownId, "Special", "qm:gateway"),
  });
  assert.equal(option?.label, "Sonnet 5");
  assert.equal(option?.buttonLabel, "Sonnet 5");
  assert.equal(option?.displayProvider, "anthropic");
  assert.equal(option?.groupLabel, "Anthropic");
  assert.equal(option?.model.provider, "qm:gateway");
  assert.equal(option?.model.id, id);
  assert.deepEqual(option?.model.cost, data.cost);
  assert.equal(unknown?.displayProvider, undefined);
  assert.equal(unknown?.groupLabel, "Gateway");
});
