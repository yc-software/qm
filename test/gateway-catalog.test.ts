import { runtimeFallback } from "../src/api/runtime-config.ts";
import { validateWebTurnModelOptions } from "../src/core/turn-options.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice } from "../src/harness/harness-router.ts";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayCatalog } from "../src/model/gateway-catalog.ts";
import { setGatewayModels } from "../src/model/gateway-models.ts";
import { modelGatewayRequest } from "../src/model/provider-endpoints.ts";
import {
  modelIdReserved,
  modelUnavailableReason,
  modelServiceable,
  modelSupportedByHarness,
  resolveModel,
  safeModelMetadata,
} from "../src/model/pi-models.ts";
import { builtInModelCatalog } from "../src/model/model-catalog.ts";
import { validateCustomProviderSpec } from "../src/model/custom-providers.ts";
import { loadConfig } from "../src/config.ts";

const config = {
  url: "https://gateway.example/prefix/v1",
  apiKey: "private-key",
  apiKeyHeader: "x-gateway-key",
  models: {},
};
const group = (id = "vendor/new-model", extra: object = {}) => ({
  model_group: id,
  mode: "chat",
  supports_function_calling: true,
  max_input_tokens: 128000,
  max_output_tokens: 8192,
  input_cost_per_token: 0.000002,
  output_cost_per_token: 0.000008,
  supports_vision: true,
  supported_openai_params: ["tools", "max_completion_tokens"],
  ...extra,
});
function fixture(models = [group()], aliases = {}) {
  let clock = 0;
  let status = 200;
  let metadata = models;
  let listing = models.map((m) => ({ id: m.model_group }));
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ data: String(url).endsWith("/models") ? listing : metadata }, { status });
  };
  const catalog = createGatewayCatalog({ ...config, models: aliases }, fetcher, () => clock);
  return {
    catalog,
    calls,
    tick: () => {
      clock += 300001;
    },
    status: (next: number) => {
      status = next;
    },
    metadata: (next: typeof models) => {
      metadata = next;
    },
    listing: (next: string[]) => {
      listing = next.map((id) => ({ id }));
    },
  };
}
afterEach(() => setGatewayModels([]));

test("gateway configuration no longer requires a model list", () => {
  const parsed = loadConfig({
    HARNESS: "mock",
    MODEL_GATEWAY_URL: config.url,
    MODEL_GATEWAY_API_KEY: config.apiKey,
    MODEL_GATEWAY_API_KEY_HEADER: config.apiKeyHeader,
  });
  assert.deepEqual(parsed.modelGateway?.models, {});
});

test("discovers unknown tool models through the company key without leaking transport metadata", async () => {
  const f = fixture([group("vendor/new-model", { api_base: "https://evil.example", api_key: "metadata-secret" })]);
  await Promise.all([f.catalog.refresh(), f.catalog.refresh()]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.calls.map((c) => c.url),
    ["https://gateway.example/prefix/v1/models", "https://gateway.example/prefix/model_group/info"],
  );
  for (const call of f.calls) {
    assert.deepEqual(call.options?.headers, { "x-gateway-key": "private-key" });
    assert.equal(call.options?.redirect, "error");
  }
  await f.catalog.refresh();
  assert.equal(f.calls.length, 2);
  const id = "gateway/vendor/new-model";
  const model = resolveModel(id)!;
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, config.url);
  assert.deepEqual(model.cost, { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
  assert.equal(modelGatewayRequest(f.catalog.transport, model)?.target, "vendor/new-model");
  assert.ok(builtInModelCatalog().some((m) => m.id === id));
  const availability = { anthropic: false, openai: false, openrouter: false, modelIds: new Set([id]) };
  assert.equal(validateWebTurnModelOptions({ model: id }, null, availability), null);
  assert.match(validateWebTurnModelOptions({ model: id }, [], availability) ?? "", /not enabled/);

  assert.equal(modelSupportedByHarness(id, "pi"), true);
  for (const harness of ["opencode", "claude", "codex"]) assert.equal(modelSupportedByHarness(id, harness), false);
  assert.equal(modelServiceable(id, { anthropic: true, openai: true, openrouter: true }), false);
  assert.equal(
    modelServiceable(id, { anthropic: false, openai: false, openrouter: false, modelIds: new Set([id]) }),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(safeModelMetadata(id)),
    /private-key|metadata-secret|evil.example|gateway.example/,
  );
});

test("only models present in both responses with valid chat capabilities are selectable", async () => {
  const f = fixture([
    group(),
    group("embed", { mode: "embedding" }),
    group("no-tools", { supports_function_calling: false }),
    group("no-context", { max_input_tokens: null }),
    group("bad-price", { input_cost_per_token: -1 }),
    group("bad-output", { max_output_tokens: 200000 }),
    group("not-authorized"),
  ]);
  f.listing(["vendor/new-model", "embed", "no-tools", "no-context", "bad-price", "bad-output"]);
  await f.catalog.refresh();
  assert.deepEqual(Object.keys(f.catalog.transport.models), ["gateway/vendor/new-model"]);
});

test("successful revocation clears legacy aliases and cached models and cannot be undone by a failure", async () => {
  const f = fixture([group()], { "claude-opus-5": "vendor/new-model" });
  await f.catalog.refresh();
  const stale = resolveModel("gateway/vendor/new-model")!;
  const native = resolveModel("claude-opus-5")!;
  assert.ok(f.catalog.transport.models["claude-opus-5"]);
  f.tick();
  f.listing([]);
  await f.catalog.refresh();
  assert.deepEqual(f.catalog.transport.models, {});
  assert.equal(resolveModel(stale.id), undefined);
  assert.match(modelUnavailableReason(stale.id) ?? "", /unavailable/);
  assert.throws(() => modelGatewayRequest(f.catalog.transport, stale), /unavailable/);
  assert.throws(() => modelGatewayRequest(f.catalog.transport, native), /unavailable/);
  f.tick();
  f.status(503);
  await f.catalog.refresh();
  assert.deepEqual(f.catalog.transport.models, {});
  assert.throws(() => modelGatewayRequest(undefined, stale), /unavailable/);
});

test("legacy routes work without discovery support, then discovery adds models and governs access", async () => {
  const f = fixture([group()], { "claude-opus-5": "vendor/new-model" });
  f.status(404);
  await f.catalog.refresh();
  assert.equal(f.catalog.transport.models["claude-opus-5"], "vendor/new-model");
  f.tick();
  f.status(200);
  await f.catalog.refresh();
  assert.ok(f.catalog.transport.models["gateway/vendor/new-model"]);
  f.tick();
  f.status(401);
  await f.catalog.refresh();
  assert.deepEqual(f.catalog.transport.models, {});
});

test("discovery outage hides stale models; later successful refresh recovers", async () => {
  const f = fixture();
  await f.catalog.refresh();
  f.tick();
  f.status(503);
  await f.catalog.refresh();
  assert.equal(resolveModel("gateway/vendor/new-model"), undefined);
  f.tick();
  f.status(200);
  f.metadata([group("new")]);
  f.listing(["new"]);
  await f.catalog.refresh();
  assert.ok(resolveModel("gateway/new"));
});

test("malformed and oversized catalogs cannot grant access", async () => {
  for (const response of [
    Response.json({ nope: [] }),
    Response.json({ data: Array(1001).fill({ id: "m" }) }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
    new Response("{}", { headers: { "content-length": "99999999" } }),
  ]) {
    const catalog = createGatewayCatalog(config, async () => response.clone());
    await catalog.refresh();
    assert.deepEqual(catalog.transport.models, {});
  }
});

test("gateway namespace cannot be registered by custom providers even before discovery", () => {
  assert.doesNotThrow(() =>
    validateCustomProviderSpec({
      id: "gateway",
      name: "Existing gateway",
      protocol: "openai",
      baseUrl: config.url,
      models: [{ id: "old-model" }],
    }),
  );
  assert.equal(modelIdReserved("gateway/future"), true);
  const spec = {
    id: "custom",
    name: "Custom",
    protocol: "openai" as const,
    baseUrl: config.url,
    models: [{ id: "gateway/future" }],
  };
  assert.throws(() => validateCustomProviderSpec(spec), /already registered/);
  assert.throws(
    () => validateCustomProviderSpec({ ...spec, id: "qm:gateway", models: [{ id: "other" }] }),
    /must match/,
  );
});

test("removed gateway selections never fall back to a different org or direct model", () => {
  const store = createMemoryConfigStore("default-org");
  const org = "org:default-org" as const;
  const personal = "personal:alice" as const;
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5" };
  store.setRuntimeSelection(org, { harnessId: "pi", modelId: "gateway/removed" });
  assert.throws(() => resolveRuntimeChoice(store, org, personal, fallback), /Gateway model is unavailable/);
  store.setRuntimeSelection(org, fallback);
  store.setRuntimeSelection(personal, { harnessId: "pi", modelId: "gateway/removed" });
  assert.throws(() => resolveRuntimeChoice(store, org, personal, fallback), /Gateway model is unavailable/);
});

test("gateway aliases hide duplicate picker options while preserving saved routes", async () => {
  const target = "anthropic/claude-opus-5";
  const f = fixture([group(target)], { "claude-opus-5": target });
  await f.catalog.refresh();
  const ids = builtInModelCatalog().map((m) => m.id);
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(!ids.includes(`gateway/${target}`));
  for (const id of ["claude-opus-5", `gateway/${target}`]) {
    assert.equal(modelGatewayRequest(f.catalog.transport, resolveModel(id)!)?.target, target);
    assert.equal(
      validateWebTurnModelOptions({ model: id }, null, {
        anthropic: false,
        openai: false,
        openrouter: false,
        modelIds: new Set([id]),
      }),
      null,
    );
  }
  f.listing([]);
  f.tick();
  await f.catalog.refresh();
  assert.equal(f.catalog.transport.models["claude-opus-5"], undefined);
  assert.equal(resolveModel(`gateway/${target}`), undefined);
});

test("unknown aliases do not hide the usable discovered model", async () => {
  const f = fixture([group()], { "unknown-alias": "vendor/new-model" });
  await f.catalog.refresh();
  assert.ok(builtInModelCatalog().some((m) => m.id === "gateway/vendor/new-model"));
});

test("resolvable aliases outside the picker do not hide discovered models", async () => {
  assert.ok(resolveModel("gpt-4o"));
  const f = fixture([group("openai/gpt-4o")], { "gpt-4o": "openai/gpt-4o" });
  await f.catalog.refresh();
  assert.ok(builtInModelCatalog().some((m) => m.id === "gateway/openai/gpt-4o"));
});

test("gateway-only fallback retains models hidden by picker aliases", async () => {
  const target = "openai/gpt-5.6-sol";
  const f = fixture([group(target)], { "gpt-5.6-sol": target });
  await f.catalog.refresh();
  assert.ok(!builtInModelCatalog().some((model) => model.id === `gateway/${target}`));
  const fallback = runtimeFallback({
    deps: { harnessId: "pi", providerKeys: { anthropic: false, openai: false, openrouter: false } },
  });
  assert.equal(fallback.modelId, `gateway/${target}`);
  assert.ok(
    modelServiceable(fallback.modelId, {
      anthropic: false,
      openai: false,
      openrouter: false,
      modelIds: new Set([`gateway/${target}`]),
    }),
  );
});
