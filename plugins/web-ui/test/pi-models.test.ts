import { test } from "node:test";
import assert from "node:assert/strict";
import { getBaseModel, modelSupportsFastMode, setFastModeModelIds } from "../src/pi-models.ts";
import { metadata } from "./model-metadata.ts";

test("models require server metadata even when the browser SDK knows their id", () => {
  assert.throws(() => getBaseModel("gpt-5.5"), /metadata unavailable/);
  assert.throws(() => getBaseModel("future", metadata("other")), /metadata unavailable/);
});

test("browser model preserves safe server geometry and does not share mutable metadata", () => {
  const spec = metadata("future", "Future", "anthropic");
  const model = getBaseModel("future", spec);
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.contextWindow, spec.contextWindow);
  model.cost.input = 999;
  assert.equal(spec.cost.input, 7);
  assert.equal(model.baseUrl, "");
});

test("fast mode support follows server updates", () => {
  setFastModeModelIds("scope", ["future"]);
  assert.equal(modelSupportsFastMode("scope", "future"), true);
  setFastModeModelIds("scope", []);
  assert.equal(modelSupportsFastMode("scope", "future"), false);
});
