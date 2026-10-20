import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { registerOpenRouterCatalogModel, resolveModel, thinkingLevelsForHarness } from "../src/model/pi-models.ts";
import { setGatewayModels, type GatewayModel } from "../src/model/gateway-models.ts";

afterEach(() => setGatewayModels([]));

test("pi offers only the efforts the model declares", () => {
  assert.deepEqual(thinkingLevelsForHarness("pi", "claude-haiku-4-5"), ["auto", "default", "low", "medium", "high"]);
  assert.ok(thinkingLevelsForHarness("pi", "gpt-6-astra").includes("ultracode"));
  assert.ok(thinkingLevelsForHarness("pi").includes("max"));
});

test("a gateway-served model keeps the registry's reasoning capabilities", () => {
  const native = resolveModel("gpt-6-astra")!;
  const { thinkingLevelMap: _dropped, ...metadataOnly } = native;
  setGatewayModels([
    { ...metadataOnly, id: "gateway/gpt-6-astra", name: "gpt-6-astra", provider: "qm:gateway" } as GatewayModel,
  ]);
  const served = resolveModel("gateway/gpt-6-astra")!;
  assert.equal(served.thinkingLevelMap?.off, null);
  assert.ok(!getSupportedThinkingLevels(served).includes("off"));
  assert.deepEqual(
    thinkingLevelsForHarness("pi", "gateway/gpt-6-astra"),
    thinkingLevelsForHarness("pi", "gpt-6-astra"),
  );
});

test("variable-priced OpenRouter models never book negative spend", () => {
  const usage = {
    input: 1_000,
    output: 1_000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const variable = registerOpenRouterCatalogModel({
    id: "vendor/variable-router",
    name: "Variable router",
    contextWindow: 100_000,
    maxTokens: 10_000,
    input: ["text"],
    reasoning: false,
    cost: { input: -1_000_000, output: -1_000_000 },
  });
  for (const model of [resolveModel("openrouter/auto"), variable]) {
    assert.ok(model);
    assert.ok(calculateCost(model, { ...usage, cost: { ...usage.cost } }).total >= 0, model.id);
  }
});
