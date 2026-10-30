import { test } from "node:test";
import assert from "node:assert/strict";
import { currentTenant, withTenant } from "../src/tenants/context.ts";
import {
  customModelCatalog,
  customProvidersVersion,
  resolveCustomModel,
  setCustomProviders,
} from "../src/model/custom-providers.ts";
import { createGatewayCatalog } from "../src/model/gateway-catalog.ts";
import { gatewayModelsVersion, resolveGatewayModel, setGatewayModels } from "../src/model/gateway-models.ts";
import { modelOverlayVersion, modelUnavailableReason, resolveModel, setModelOverlays } from "../src/model/pi-models.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { selectableModelCatalog } from "../src/model/model-catalog.ts";
import {
  oauthProvider,
  publicOAuthClientsReady,
  setPublicOAuthClientSource,
  setPublicOAuthClients,
  withPublicOAuthClients,
} from "../src/connectors/oauth.ts";
import { createBudgetTracker } from "../src/ratelimit/budget.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import type { McpServer, McpServerStore } from "../src/mcp/mcp-server-store.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const UNBOUND = /No tenant is bound/;

function provider(baseUrl: string) {
  return { id: "shared", name: "Shared", protocol: "openai" as const, baseUrl, models: [{ id: "m1" }] };
}

test("custom providers registered in one tenant are invisible to another and fail closed when unbound", () => {
  withTenant(A, () => setCustomProviders([provider("https://a.example/v1")]));
  withTenant(B, () => setCustomProviders([provider("https://b.example/v1")]));
  assert.equal(
    withTenant(A, () => resolveCustomModel("custom/shared/m1")?.baseUrl),
    "https://a.example/v1",
  );
  assert.equal(
    withTenant(B, () => resolveCustomModel("custom/shared/m1")?.baseUrl),
    "https://b.example/v1",
  );
  const versionB = withTenant(B, customProvidersVersion);
  withTenant(A, () => setCustomProviders([]));
  assert.equal(
    withTenant(A, () => resolveCustomModel("custom/shared/m1")),
    undefined,
  );
  assert.equal(withTenant(B, customProvidersVersion), versionB);
  assert.equal(
    withTenant(B, () => customModelCatalog().length),
    1,
  );
  assert.throws(() => resolveCustomModel("custom/shared/m1"), UNBOUND);
  assert.throws(() => setCustomProviders([]), UNBOUND);
  withTenant(B, () => setCustomProviders([]));
});

test("gateway models and their version are per tenant", () => {
  const model = (baseUrl: string) =>
    ({
      id: "gateway/vendor/m",
      name: "m",
      provider: "qm:gateway",
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }) as Parameters<typeof setGatewayModels>[0][number];
  withTenant(A, () => setGatewayModels([model("https://a.example/v1")]));
  const versionB = withTenant(B, gatewayModelsVersion);
  assert.equal(
    withTenant(B, () => resolveGatewayModel("gateway/vendor/m")),
    undefined,
  );
  assert.equal(
    withTenant(B, () => resolveModel("gateway/vendor/m")),
    undefined,
  );
  assert.equal(
    withTenant(A, () => resolveModel("gateway/vendor/m")?.baseUrl),
    "https://a.example/v1",
  );
  withTenant(B, () => setGatewayModels([model("https://b.example/v1")]));
  assert.equal(
    withTenant(A, () => resolveGatewayModel("gateway/vendor/m")?.baseUrl),
    "https://a.example/v1",
  );
  assert.equal(
    withTenant(B, () => resolveGatewayModel("gateway/vendor/m")?.baseUrl),
    "https://b.example/v1",
  );
  assert.equal(withTenant(B, gatewayModelsVersion), versionB + 1);
  assert.throws(() => resolveGatewayModel("gateway/vendor/m"), UNBOUND);
  withTenant(A, () => setGatewayModels([]));
  withTenant(B, () => setGatewayModels([]));
});

test("gateway discovery runs and caches per tenant", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url));
    const data = String(url).endsWith("/models")
      ? [{ id: "vendor/m" }]
      : [
          {
            model_group: "vendor/m",
            mode: "chat",
            supports_function_calling: true,
            max_input_tokens: 128000,
            max_output_tokens: 8192,
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.000008,
          },
        ];
    return Response.json({ data });
  };
  const catalog = createGatewayCatalog(
    { url: "https://gateway.example/v1", apiKey: "k", apiKeyHeader: "x-key", models: {} },
    fetcher,
    () => 0,
  );
  await withTenant(A, () => catalog.refresh());
  assert.deepEqual(
    withTenant(A, () => catalog.transport.models),
    { "gateway/vendor/m": "vendor/m" },
  );
  assert.deepEqual(
    withTenant(B, () => catalog.transport.models),
    {},
  );
  assert.equal(
    withTenant(B, () => resolveGatewayModel("gateway/vendor/m")),
    undefined,
  );
  await withTenant(A, () => catalog.refresh());
  assert.equal(calls.length, 2);
  await withTenant(B, () => catalog.refresh());
  assert.equal(calls.length, 4);
  assert.ok(withTenant(B, () => resolveGatewayModel("gateway/vendor/m")));
  assert.throws(() => catalog.transport.models, UNBOUND);
  withTenant(A, () => setGatewayModels([]));
  withTenant(B, () => setGatewayModels([]));
});

test("model overlays, unavailable reasons and the overlay version are per tenant", () => {
  const versionB = withTenant(B, modelOverlayVersion);
  withTenant(A, () => setModelOverlays([], ["vendor/gone"]));
  assert.match(withTenant(A, () => modelUnavailableReason("vendor/gone")) ?? "", /deleted/);
  assert.equal(
    withTenant(B, () => modelUnavailableReason("vendor/gone")),
    undefined,
  );
  assert.equal(withTenant(B, modelOverlayVersion), versionB);
  withTenant(B, () => setModelOverlays([], ["vendor/other"]));
  withTenant(A, () => setModelOverlays([]));
  assert.equal(
    withTenant(A, () => modelUnavailableReason("vendor/gone")),
    undefined,
  );
  assert.match(withTenant(B, () => modelUnavailableReason("vendor/other")) ?? "", /deleted/);
  assert.throws(() => resolveModel("claude-opus-5"), UNBOUND);
  withTenant(B, () => setModelOverlays([]));
});

test("the OpenRouter catalog is fetched, registered and cached per tenant", async () => {
  let fetches = 0;
  const catalog: typeof fetch = async () => {
    fetches += 1;
    return Response.json({
      data: [
        {
          id: "stealth/ox-alpha",
          name: "Ox Alpha",
          context_length: 1_048_576,
          pricing: { prompt: "0", completion: "0" },
          top_provider: { max_completion_tokens: 131_072 },
          architecture: { input_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    });
  };
  await withTenant(A, () => selectableModelCatalog(catalog));
  await withTenant(A, () => selectableModelCatalog(catalog));
  assert.equal(fetches, 1);
  assert.equal(
    withTenant(A, () => resolveModel("stealth/ox-alpha")?.provider),
    "openrouter",
  );
  assert.equal(
    withTenant(B, () => resolveModel("stealth/ox-alpha")),
    undefined,
  );
  await withTenant(B, () => selectableModelCatalog(catalog));
  assert.equal(fetches, 2);
  assert.equal(
    withTenant(B, () => resolveModel("stealth/ox-alpha")?.provider),
    "openrouter",
  );
  await assert.rejects(selectableModelCatalog(catalog), UNBOUND);
});

test("public OAuth clients registered for one tenant do not resolve in another", async () => {
  const client = (clientId: string) => ({
    name: "acme",
    host: "acme.example",
    authUrl: "https://acme.example/authorize",
    tokenUrl: "https://acme.example/token",
    scopes: [],
    clientId,
    label: "Acme",
  });
  withTenant(A, () => setPublicOAuthClients([client("client-a")]));
  withTenant(B, () => setPublicOAuthClients([client("client-b")]));
  const resolve = withPublicOAuthClients(async () => ({ id: "fallback", secret: "", clientRef: "fallback" }));
  assert.equal((await withTenant(A, () => resolve("acme", {} as never)))?.id, "client-a");
  assert.equal((await withTenant(B, () => resolve("acme", {} as never)))?.id, "client-b");
  withTenant(A, () => setPublicOAuthClients([]));
  assert.equal(
    withTenant(A, () => oauthProvider("acme")),
    undefined,
  );
  assert.ok(withTenant(B, () => oauthProvider("acme")));
  assert.throws(() => oauthProvider("acme"), UNBOUND);
  withTenant(B, () => setPublicOAuthClients([]));
});

test("a cold tenant loads its own public OAuth clients before resolving one", async () => {
  const C = "00000000-0000-4000-8000-00000000000c";
  const D = "00000000-0000-4000-8000-00000000000d";
  let loads = 0;
  setPublicOAuthClientSource(async () => {
    loads += 1;
    return currentTenant() === C
      ? [
          {
            name: "acme",
            host: "acme.example",
            authUrl: "https://acme.example/authorize",
            tokenUrl: "https://acme.example/token",
            scopes: [],
            clientId: "client-c",
            label: "Acme",
          },
        ]
      : [];
  });
  const resolve = withPublicOAuthClients(async () => ({ id: "fallback", secret: "", clientRef: "fallback" }));
  assert.equal((await withTenant(C, () => resolve("acme", {} as never)))?.id, "client-c");
  assert.equal((await withTenant(D, () => resolve("acme", {} as never)))?.id, "fallback");
  await withTenant(C, () => publicOAuthClientsReady());
  assert.equal(loads, 2);
  assert.equal(
    withTenant(D, () => oauthProvider("acme")),
    undefined,
  );
  await assert.rejects(publicOAuthClientsReady(), UNBOUND);
});

test("model call records, budgets and rate limits are counted per tenant", async () => {
  const gateway = createModelGateway();
  withTenant(A, () =>
    gateway.recordCall({ at: 1, scopeLabel: "s" as never, model: "m", inputTokens: 1, entryCount: 1 }),
  );
  assert.equal(
    withTenant(A, () => gateway.audit().length),
    1,
  );
  assert.equal(
    withTenant(B, () => gateway.audit().length),
    0,
  );
  assert.throws(() => gateway.audit(), UNBOUND);

  const budget = createBudgetTracker({ limitUsd: 1, orgLimitUsd: 2 });
  await withTenant(A, () => budget.record("u", 1.5, 10));
  assert.equal((await withTenant(A, () => budget.check("u", 10))).allowed, false);
  assert.deepEqual(await withTenant(B, () => budget.check("u", 10)), { allowed: true, spentUsd: 0, limitUsd: 2 });
  await assert.rejects(budget.check("u", 10), UNBOUND);

  const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 1000, now: () => 0 });
  assert.equal((await withTenant(A, () => limiter.check("u"))).allowed, true);
  assert.equal((await withTenant(A, () => limiter.check("u"))).allowed, false);
  assert.equal((await withTenant(B, () => limiter.check("u"))).allowed, true);
  await assert.rejects(limiter.check("u"), UNBOUND);
});

test("MCP tool snapshots load and refresh per tenant", async (t) => {
  const crm = await startMcpTestServer(t);
  const crmServer: McpServer = {
    id: "crm",
    name: "CRM",
    url: `${crm.url}/mcp`,
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
  };
  const servers = new Map<string, McpServer[]>([
    [A, [crmServer]],
    [B, []],
  ]);
  const store: McpServerStore = {
    list: async () => servers.get(currentTenant()) ?? [],
    get: async (id) => (servers.get(currentTenant()) ?? []).find((s) => s.id === id) ?? null,
    put: async () => {},
    delete: async () => {},
    onChange: () => () => {},
  };
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  t.after(() => service.close());
  const namesA = (await withTenant(A, () => service.toolDefsFor())).map((d) => d.name).sort();
  assert.deepEqual(namesA, ["crm_query", "crm_update"]);
  assert.deepEqual(await withTenant(B, () => service.toolDefsFor()), []);
  await assert.rejects(
    withTenant(B, () => service.call("crm_query", {})),
    /unknown MCP tool/,
  );
  assert.equal(await withTenant(A, () => service.call("crm_query", {})), "ran query");
  servers.set(A, []);
  await withTenant(A, () => service.refresh());
  assert.deepEqual(
    withTenant(A, () => service.toolDefs()),
    [],
  );
  assert.throws(() => service.toolDefs(), UNBOUND);
});

test("a cold tenant's first turn waits only briefly for MCP tools that are slow to list", async (t) => {
  const store: McpServerStore = {
    list: () => new Promise<McpServer[]>(() => {}),
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    onChange: () => () => {},
  };
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  t.after(() => service.close());
  const started = Date.now();
  assert.deepEqual(await withTenant(A, () => service.toolDefsFor()), []);
  assert.ok(Date.now() - started < 3_000);
});
