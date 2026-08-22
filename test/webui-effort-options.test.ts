import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { supportedEffortLevelsForModel } from "../src/model/pi-models.ts";
import {
  applyRuntimeOptions,
  effortOptionsFor,
  getModelOptions,
  supportsEffort,
} from "../plugins/web-ui/src/model-options.ts";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";

function fakeModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "openai-responses",
    provider: "openrouter",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
    ...overrides,
  } as Model<"openai-responses">;
}

function modelOption(model: Model<"openai-responses">, harnessId = "pi") {
  return {
    value: `${harnessId}:${model.id}`,
    harnessId,
    harnessLabel: harnessId,
    groupLabel: "Test",
    model,
    label: model.name,
    buttonLabel: model.name,
  };
}

test("supportedEffortLevelsForModel derives levels from reasoning and thinkingLevelMap", () => {
  assert.deepEqual(supportedEffortLevelsForModel(fakeModel({ reasoning: false })), ["auto"]);
  assert.deepEqual(
    supportedEffortLevelsForModel(fakeModel({ thinkingLevelMap: { low: null, medium: null } })),
    ["auto", "high", "xhigh", "max", "ultracode"],
  );
  // ultracode aliases to max at turn time, so a null max drops it too
  assert.deepEqual(
    supportedEffortLevelsForModel(fakeModel({ thinkingLevelMap: { max: null } })),
    ["auto", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    supportedEffortLevelsForModel(fakeModel({ thinkingLevelMap: { high: "only-high" } })),
    ["auto", "low", "medium", "high", "xhigh", "max", "ultracode"],
  );
});

test("effortOptionsFor filters by model capability and harness cap, honoring server overrides", () => {
  // non-reasoning models only offer the provider default
  const nonReasoning = modelOption(fakeModel({ reasoning: false }));
  assert.deepEqual(effortOptionsFor(nonReasoning).map((entry) => entry.value), ["auto"]);
  assert.ok(!supportsEffort(nonReasoning, "ultracode"));

  // codex never forwards max/ultracode even when the model supports them
  assert.deepEqual(
    effortOptionsFor(modelOption(fakeModel(), "codex")).map((entry) => entry.value),
    ["auto", "low", "medium", "high", "xhigh"],
  );

  // a server-provided override wins over client-side derivation (dynamic models)
  applyRuntimeOptions(null, ["pi"], { pi: ["claude-opus-5"] }, { harnessId: "pi", modelId: "claude-opus-5" }, {
    "claude-opus-5": { name: "Claude Opus 5", provider: "anthropic", effortLevels: ["auto", "medium"] },
  });
  const dynamic = getModelOptions().find((entry) => entry.model.id === "claude-opus-5")!;
  assert.deepEqual(effortOptionsFor(dynamic).map((entry) => entry.value), ["auto", "medium"]);
});

test("runtime-config advertises per-model effortLevels", async () => {
  const modelCredentialFetch: typeof fetch = async () =>
    Response.json({
      data: [{ id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek: DeepSeek V3.1", supported_parameters: ["tools"] }],
    });
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "webui-effort-options-")),
      openrouterApiKey: "effort-options-openrouter-key",
    }),
    { modelCredentialFetch },
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    harnessId: "pi",
    providerKeys: { anthropic: false, openai: false, openrouter: true },
    modelCredentialFetch,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      modelCatalog: Record<string, { name: string; provider: string; effortLevels?: string[] }>;
      modelsByHarness: Record<string, string[]>;
    };
    const deepseek = body.modelCatalog["deepseek/deepseek-chat-v3.1"];
    assert.ok(deepseek, "the openrouter catalog model should be advertised");
    assert.ok(Array.isArray(deepseek.effortLevels), `expected effortLevels, got ${JSON.stringify(deepseek)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
