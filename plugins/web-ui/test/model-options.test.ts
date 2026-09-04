import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyRuntimeOptions,
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

test("server metadata controls picker labels, geometry, price, order and effective selection", () => {
  applyRuntimeOptions(
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

test("empty, unknown, missing-metadata and unapproved lists stay empty", () => {
  for (const options of [
    runtimeModelOptions([], { pi: ["future"] }, catalog),
    runtimeModelOptions(["pi"], { pi: [] }, catalog),
    runtimeModelOptions(["pi"], { pi: ["future"] }),
    runtimeModelOptions(["pi"], { pi: ["unknown"] }, catalog),
  ])
    assert.deepEqual(options, []);
  applyRuntimeOptions("scope:empty", ["pi"], { pi: [] }, { harnessId: "pi", modelId: "future" }, catalog);
  assert.deepEqual(getModelOptions("scope:empty"), []);
  assert.equal(defaultModelValue("scope:empty"), "pi:future");
  assert.equal(transcriptModel("scope:empty"), undefined);
  assert.deepEqual(getHarnessOptions("scope:empty"), []);
});

test("scopes retain independent choices and an unloaded scope does not borrow another policy", () => {
  applyRuntimeOptions("scope:a", ["pi"], { pi: ["future"] }, { harnessId: "pi", modelId: "future" }, catalog);
  applyRuntimeOptions("scope:b", ["mock"], { mock: ["custom"] }, { harnessId: "mock", modelId: "custom" }, catalog);
  assert.equal(defaultModelValue("scope:a"), "pi:future");
  assert.equal(defaultModelValue("scope:b"), "mock:custom");
  assert.deepEqual(getModelOptions("scope:new"), []);
});

test("OpenRouter and custom provider metadata retains provider grouping", () => {
  const models = { "vendor/new": metadata("vendor/new", "Vendor: New", "openrouter"), custom: catalog.custom };
  const options = runtimeModelOptions(["pi"], { pi: Object.keys(models) }, models);
  assert.deepEqual(
    options.map((m) => m.groupLabel),
    ["Vendor", "Gateway"],
  );
});

test("picker has no model IDs, clone templates or runtime SDK model registry imports", () => {
  const source = ["pi-models.ts", "model-options.ts"]
    .map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /MODEL_CATALOG|CLONE_TEMPLATES|gpt-5|claude-opus|openrouter\/auto|import \{ getModel/);
});

test("harness controls retain their supported surfaces", () => {
  assert.equal(harnessSupportsEffort("pi"), true);
  assert.equal(harnessSupportsEffort("opencode"), false);
  assert.equal(harnessSupportsFastMode("claude"), true);
  assert.equal(harnessSupportsFastMode("codex"), false);
});

test("deleted selection retains identity and transcript rendering does not borrow a replacement", () => {
  applyRuntimeOptions("scope:deleted", ["pi"], { pi: ["custom"] }, { harnessId: "pi", modelId: "future" }, catalog);
  assert.equal(defaultModelValue("scope:deleted"), "pi:future");
  assert.equal(transcriptModel("scope:deleted"), undefined);
  assert.deepEqual(
    getModelOptions("scope:deleted").map((model) => model.value),
    ["pi:custom"],
  );
  applyRuntimeOptions("scope:deleted", ["pi"], { pi: ["custom"] }, { harnessId: "pi", modelId: "custom" }, catalog);
  assert.equal(defaultModelValue("scope:deleted"), "pi:custom");
  assert.equal(transcriptModel("scope:deleted")?.id, "custom");
});
