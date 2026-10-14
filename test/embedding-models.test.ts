import "./support/auto-fake-sprites.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createGatewayCatalog } from "../src/model/gateway-catalog.ts";
import { gatewayModelsJson, setGatewayModels } from "../src/model/gateway-models.ts";
import { createMemoryEmbedder } from "../src/model/embeddings.ts";
import { createModelVerifier } from "../src/model/model-verification.ts";
import { createModelOverlayStore } from "../src/model/model-overlay-store.ts";
import { createModelCredentialStore } from "../src/model/model-credential-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedBaseModel } from "../src/resolution/config-store.ts";
import {
  setModelOverlays,
  resolveModel,
  resolveEmbeddingModel,
  embeddingModelCatalog,
  selectableBaseModels,
  defaultWebuiModelIds,
  modelSupportedByHarness,
} from "../src/model/pi-models.ts";
import { recallText } from "./support/recall-text.ts";

const definition = {
  kind: "embedding",
  id: "embed-small",
  name: "Small embeddings",
  provider: "openai",
};
afterEach(() => {
  setModelOverlays([]);
  setGatewayModels([]);
});

test("verified embedding definitions survive registry reload but never become chat models", async () => {
  const credentials = createModelCredentialStore({
    backing: createMemoryMap(),
    keyMaterial: "test-key",
    fallback: { openai: "test-key" },
  });
  const requests: unknown[] = [];
  const verifier = createModelVerifier({
    credentials,
    keyMaterial: "test-key",
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ data: [{ index: 0, embedding: [3, 4] }] });
    },
  });
  const backing = createMemoryMap<import("../src/model/model-overlay-store.ts").StoredModelOverlay>();
  const writer = createModelOverlayStore(backing, undefined, verifier);
  await writer.upsert(definition, "admin");
  await assert.rejects(
    writer.upsert(
      {
        id: definition.id,
        name: "Accidental chat edit",
        provider: "openai",
        template: "gpt-5.5",
        contextWindow: 200000,
        maxTokens: 16000,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      "admin",
    ),
    /kind cannot change/,
  );

  await createModelOverlayStore(backing, undefined, verifier).refresh();
  assert.deepEqual(requests, [{ model: "embed-small", input: ["verification"], encoding_format: "float" }]);
  assert.equal(resolveModel("embed-small"), undefined);
  assert.ok(!selectableBaseModels().some((m) => m.id === "embed-small"));
  assert.ok(!defaultWebuiModelIds().includes("embed-small"));
  for (const harness of ["pi", "claude", "codex", "opencode", "mock"])
    assert.equal(modelSupportedByHarness("embed-small", harness), false);
  await writer.delete("embed-small", "admin");
  await writer.refresh();
  assert.equal(resolveEmbeddingModel("embed-small"), undefined);
});

test("key-scoped gateway embeddings need no chat capabilities and use gateway credentials only", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const catalog = createGatewayCatalog(
    {
      url: "https://gateway.example/v1",
      apiKey: "gateway-key",
      apiKeyHeader: "x-gateway-key",
      models: { "gpt-5.5": "embed" },
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        data: String(url).endsWith("/models")
          ? [{ id: "embed" }]
          : [
              { model_group: "embed", mode: "embedding" },
              { model_group: "inaccessible", mode: "embedding" },
            ],
      });
    },
  );
  await catalog.refresh();
  assert.deepEqual(
    embeddingModelCatalog().map((m) => m.id),
    ["gateway/embed"],
  );
  assert.equal(resolveModel("gateway/embed"), undefined);
  assert.equal(catalog.transport.models["gpt-5.5"], undefined);
  assert.deepEqual(gatewayModelsJson(), {});
  const embedder = createMemoryEmbedder(
    resolveEmbeddingModel("gateway/embed")!,
    "must-not-leak",
    catalog.transport,
    async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ data: [{ index: 0, embedding: [3, 4] }] });
    },
  );
  assert.deepEqual(await embedder.embed(["query"], AbortSignal.timeout(1000)), [[0.6, 0.8]]);
  const request = calls.at(-1)!;
  assert.equal(request.url, "https://gateway.example/v1/embeddings");
  assert.deepEqual(request.init?.headers, { "content-type": "application/json", "x-gateway-key": "gateway-key" });
  assert.equal(JSON.parse(String(request.init?.body)).model, "embed");
  setGatewayModels([]);
  assert.equal(resolveEmbeddingModel("gateway/embed"), undefined);
});

test("org embedding selection is durable and survives chat runtime replacement and clearing", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const first = createMemoryConfigStore("test", { baseModels });
  await first.setEmbeddingModel("gateway/embed");
  await first.setRuntimeSelectionLatest("org:test", { harnessId: "pi", modelId: "gpt-5.5" });
  await first.setRuntimeSelectionLatest("org:test", null);
  const restarted = createMemoryConfigStore("test", { baseModels });
  assert.equal(await restarted.getEmbeddingModelDurable(), "gateway/embed");
  await restarted.setEmbeddingModel(null);
  assert.equal(await first.getEmbeddingModelDurable(), null);
});

test("HTTP embedding selection accepts only known embedding models and survives a new recall", async (t) => {
  const config = testConfig({ openaiApiKey: "test-key" });
  const built = buildApp(config, {
    modelCredentialFetch: async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
  });
  await built.modelRegistry.upsert(definition, "admin");
  await built.refreshModels();
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/scopes/org:default-org/memory-embedding-model`;
  const put = (body: object) =>
    fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ modelId: definition.id })).status, 200);
  assert.equal(await built.config.getEmbeddingModelDurable(), definition.id);
  const models = await fetch(url.replace(/\/memory-embedding-model$/, "?view=models"), {
    headers: { "x-admin-actor": "admin-alice@default-org" },
  });
  const view = (await models.json()) as { memoryEmbeddingModel: string; memoryEmbeddingOptions: { id: string }[] };
  assert.equal(view.memoryEmbeddingModel, definition.id);
  assert.ok(view.memoryEmbeddingOptions.some((model) => model.id === definition.id));
  await built.memory.capture("personal:test", ["first fact"], Date.now());
  assert.match(recallText(await built.memory.recall("personal:test", { query: "first" })), /first fact/);
  assert.equal((await put({ modelId: "gpt-5.5" })).status, 400);
  assert.equal((await put({ modelId: null })).status, 200);
  assert.equal(await built.config.getEmbeddingModelDurable(), null);
});
