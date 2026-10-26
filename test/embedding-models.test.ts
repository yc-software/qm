import "./support/auto-fake-sprites.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createGatewayCatalog } from "../src/model/gateway-catalog.ts";
import { gatewayModelsJson, setGatewayModels } from "../src/model/gateway-models.ts";
import { createMemoryEmbedder } from "../src/model/embeddings.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedBaseModel } from "../src/resolution/config-store.ts";
import {
  resolveModel,
  resolveEmbeddingModel,
  embeddingModelCatalog,
  selectableBaseModels,
  defaultWebuiModelIds,
  modelSupported,
} from "../src/model/pi-models.ts";
import { recallText } from "./support/recall-text.ts";

const OPENAI_EMBEDDING = "text-embedding-3-small";
afterEach(() => {
  setGatewayModels([]);
});

test("built-in OpenAI embeddings use the organization key and never become chat models", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const embedder = createMemoryEmbedder(
    resolveEmbeddingModel(OPENAI_EMBEDDING)!,
    "org-openai-key",
    undefined,
    async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ data: [{ index: 0, embedding: [3, 4] }] });
    },
  );
  assert.deepEqual(await embedder.embed(["query"], AbortSignal.timeout(1000)), [[0.6, 0.8]]);
  assert.equal(requests[0]!.url, "https://api.openai.com/v1/embeddings");
  assert.deepEqual(requests[0]!.init?.headers, {
    "content-type": "application/json",
    authorization: "Bearer org-openai-key",
  });
  assert.equal(resolveModel(OPENAI_EMBEDDING), undefined);
  assert.ok(!selectableBaseModels().some((m) => m.id === OPENAI_EMBEDDING));
  assert.ok(!defaultWebuiModelIds().includes(OPENAI_EMBEDDING));
  assert.equal(modelSupported(OPENAI_EMBEDDING), false);
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
    embeddingModelCatalog()
      .filter((m) => m.provider === "qm:gateway")
      .map((m) => m.id),
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
  await first.setRuntimeSelection("org:test", { modelId: "gpt-5.5" });
  await first.setRuntimeSelection("org:test", null);
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
  assert.equal((await put({ modelId: OPENAI_EMBEDDING })).status, 200);
  assert.equal(await built.config.getEmbeddingModelDurable(), OPENAI_EMBEDDING);
  const models = await fetch(url.replace(/\/memory-embedding-model$/, "?view=models"), {
    headers: { "x-admin-actor": "admin-alice@default-org" },
  });
  const view = (await models.json()) as { memoryEmbeddingModel: string; memoryEmbeddingOptions: { id: string }[] };
  assert.equal(view.memoryEmbeddingModel, OPENAI_EMBEDDING);
  assert.ok(view.memoryEmbeddingOptions.some((model) => model.id === OPENAI_EMBEDDING));
  await built.memory.capture("personal:test", ["first fact"], Date.now());
  assert.match(recallText(await built.memory.recall("personal:test", { query: "first" })), /first fact/);
  assert.equal((await put({ modelId: "gpt-5.5" })).status, 400);
  assert.equal((await put({ modelId: null })).status, 200);
  assert.equal(await built.config.getEmbeddingModelDurable(), null);
});
