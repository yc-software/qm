import "../support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { stopAtEnd } from "../support/build-app.ts";
import { providerKeysPresent, companySubscriptionAuth } from "../../src/config.ts";
import { testConfig } from "../support/test-config.ts";
import { createModelCredentialStore } from "../../src/model/model-credential-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { getRequiredModel, MODEL_REGISTRY, modelServiceable, resolveModel } from "../../src/model/pi-models.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const buildApp = (...args: Parameters<typeof buildProductionApp>) => stopAtEnd(buildProductionApp(...args));

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(
  config: Parameters<typeof testConfig>[0] = {},
  modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 }),
): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const appConfig = testConfig({ ...config });
  const built = buildApp(appConfig, { modelCredentialFetch });
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    userModelCredentials: built.userModelCredentials,
    modelCredentialFetch,
    ...(companySubscriptionAuth(appConfig) ? { companySubscriptionAuth: companySubscriptionAuth(appConfig) } : {}),
    providerKeys: providerKeysPresent(appConfig),
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("admin model credentials are encrypted, write-only, live, and removable", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    const initial = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      providers: [
        { provider: "anthropic", configured: true, source: "environment" },
        { provider: "openai", configured: false, source: "absent" },
        { provider: "openrouter", configured: false, source: "absent" },
      ],
      models: [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
        { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic" },
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
        { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai" },
        { id: "gpt-6-astra-ultrafast", name: "GPT-6 Astra · Ultrafast (6× cost)", provider: "openai" },
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai" },
        { id: "gpt-6.1-sol-ultrafast", name: "GPT-6.1 Sol · Ultrafast (6× cost)", provider: "openai" },
        { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", provider: "openai" },
        { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai" },
        { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" },
        { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
      ],
    });
    const scopeBefore = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(scopeBefore.status, 200);
    const beforeOptions = ((await scopeBefore.json()) as { baseModelOptions: Array<{ id: string }> }).baseModelOptions;
    assert.ok(!beforeOptions.some((model) => model.id === "gpt-5.6-sol"));

    const denied = await fetch(`${srv.base}/v1/admin/model-providers/openai`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ apiKey: "denied-openai-key" }),
    });
    assert.equal(denied.status, 403);

    const saved = await fetch(`${srv.base}/v1/admin/model-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ apiKey: "admin-openai-key" }),
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /admin-openai-key/);
    assert.equal(await srv.built.modelCredentials.resolve("openai"), "admin-openai-key");
    const scopeAfter = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(scopeAfter.status, 200);
    const afterOptions = ((await scopeAfter.json()) as { baseModelOptions: Array<{ id: string }> }).baseModelOptions;
    assert.ok(afterOptions.some((model) => model.id === "gpt-5.6-sol"));

    const status = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /deployment-anthropic-key|admin-openai-key/);
    assert.match(statusText, /"source":"admin"/);

    const removed = await fetch(`${srv.base}/v1/admin/model-providers/openai`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(removed.status, 200);
    assert.equal(await srv.built.modelCredentials.resolve("openai"), null);
    assert.equal(await srv.built.modelCredentials.resolve("anthropic"), "deployment-anthropic-key");
  } finally {
    await srv.close();
  }
});

test("model gateway credentials stay separate and advertise only routed models", async () => {
  const partial = buildApp(
    testConfig({
      modelGateway: {
        url: "http://gateway.internal:8080",
        apiKey: "gateway-secret",
        apiKeyHeader: "api-key",
        models: { "claude-opus-5": "router/opus" },
      },
    }),
  );
  assert.equal(await partial.modelCredentials.resolve("anthropic"), null);
  const partialAvailability = await partial.modelCredentials.availability();
  assert.equal(partialAvailability.anthropic, false);
  assert.equal(modelServiceable("claude-opus-5", partialAvailability), true);
  assert.equal(modelServiceable("claude-sonnet-4-5", partialAvailability), false);
  await partial.modelCredentials.set("anthropic", "admin-anthropic-key", "admin-alice");
  assert.equal(modelServiceable("claude-sonnet-4-5", await partial.modelCredentials.availability()), true);

  const openrouter = buildApp(
    testConfig({
      modelGateway: {
        url: "http://gateway.internal:8080",
        apiKey: "gateway-secret",
        apiKeyHeader: "api-key",
        models: { "openrouter/auto": "router/auto" },
      },
    }),
  );
  const openrouterAvailability = await openrouter.modelCredentials.availability();
  assert.equal(openrouterAvailability.openrouter, false);
  assert.equal(modelServiceable("openrouter/auto", openrouterAvailability), true);
  assert.equal(modelServiceable("openai/gpt-4o", openrouterAvailability), false);

  const anthropicModels = Object.fromEntries(
    MODEL_REGISTRY.filter(({ id }) => resolveModel(id)?.provider === "anthropic").map(({ id }) => [id, `router/${id}`]),
  );
  const complete = buildApp(
    testConfig({
      modelGateway: {
        url: "http://gateway.internal:8080",
        apiKey: "gateway-secret",
        apiKeyHeader: "api-key",
        models: anthropicModels,
      },
    }),
  );
  assert.equal(await complete.modelCredentials.resolve("anthropic"), null);
  const completeAvailability = await complete.modelCredentials.availability();
  assert.equal(completeAvailability.anthropic, false);
  assert.ok(Object.keys(anthropicModels).every((id) => modelServiceable(id, completeAvailability)));

  const srv = start({
    modelGateway: {
      url: "http://gateway.internal:8080",
      apiKey: "gateway-secret",
      apiKeyHeader: "api-key",
      models: anthropicModels,
    },
  });
  try {
    const selected = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org/runtime`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-5" }),
    });
    assert.equal(selected.status, 200);
  } finally {
    await srv.close();
  }

  const direct = buildApp(
    testConfig({
      anthropicApiKey: "direct-provider-key",
      modelGateway: {
        url: "http://gateway.internal:8080",
        apiKey: "gateway-secret",
        apiKeyHeader: "api-key",
        models: { "claude-opus-5": "router/opus" },
      },
    }),
  );
  assert.equal(await direct.modelCredentials.resolve("anthropic"), "direct-provider-key");
});

test("OpenRouter validation uses an authenticated endpoint", async () => {
  let requested = "";
  const srv = start({}, async (input) => {
    requested = String(input);
    return new Response(null, { status: 401 });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/openrouter`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ apiKey: "not-a-real-key" }),
    });
    assert.equal(response.status, 400);
    assert.equal(requested, "https://openrouter.ai/api/v1/key");
    assert.equal(await srv.built.modelCredentials.resolve("openrouter"), null);
  } finally {
    await srv.close();
  }
});

test("OpenRouter catalog exposes runtime-supported tool models as selectable base models", async () => {
  let requested = "";
  let catalogRequests = 0;
  const srv = start({ openrouterApiKey: "deployment-openrouter-key" }, async (input) => {
    requested = String(input);
    catalogRequests++;
    return Response.json({
      data: [
        {
          id: "anthropic/claude-sonnet-4.5",
          name: "Anthropic: Claude Sonnet 4.5",
          supported_parameters: ["tools"],
        },
        {
          id: "stealth/ox-alpha",
          name: "Ox Alpha",
          context_length: 1_048_576,
          pricing: { prompt: "0", completion: "0" },
          top_provider: { max_completion_tokens: 131_072 },
          architecture: { input_modalities: ["text", "image", "video"] },
          supported_parameters: ["tools", "reasoning", "reasoning_effort"],
        },
        {
          id: "future/incomplete-model",
          name: "Incomplete Future Model",
          context_length: 128_000,
          pricing: { prompt: "0", completion: "0" },
          architecture: { input_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
        {
          id: "openai/gpt-4o",
          name: "No Tools",
          supported_parameters: ["temperature"],
        },
      ],
    });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const models = (
      (await response.json()) as {
        models: Array<{ id: string; name: string; provider: string }>;
      }
    ).models.filter((model) => model.provider === "openrouter");
    assert.deepEqual(models, [
      { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
      { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", provider: "openrouter" },
      { id: "stealth/ox-alpha", name: "Ox Alpha", provider: "openrouter" },
    ]);
    const dynamic = getRequiredModel("stealth/ox-alpha");
    assert.equal(dynamic.provider, "openrouter");
    assert.equal(dynamic.contextWindow, 1_048_576);
    assert.equal(dynamic.maxTokens, 131_072);
    assert.deepEqual(dynamic.input, ["text", "image"]);
    assert.deepEqual(dynamic.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(requested, "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular");

    const selected = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "stealth/ox-alpha" }),
    });
    assert.equal(selected.status, 200);
    assert.equal(srv.built.config.getRuntimeSelection("org:default-org")?.modelId ?? null, "stealth/ox-alpha");

    const governance = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(governance.status, 200);
    const governanceBody = (await governance.json()) as {
      baseModelOptions: Array<{ id: string; name: string }>;
      runtime: { modelId: string };
    };
    assert.ok(governanceBody.baseModelOptions.some((model) => model.id === "stealth/ox-alpha"));
    assert.equal(governanceBody.runtime.modelId, "stealth/ox-alpha");

    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const runtimeBody = (await runtime.json()) as {
      models: string[];
      modelCatalog: Record<string, { name: string; provider: string }>;
      effective: { modelId: string };
    };
    assert.ok(runtimeBody.models.includes("stealth/ox-alpha"));
    assert.equal(runtimeBody.modelCatalog["stealth/ox-alpha"]?.name, "Ox Alpha");
    assert.equal(runtimeBody.modelCatalog["stealth/ox-alpha"]?.provider, "openrouter");
    assert.deepEqual(runtimeBody.effective, { modelId: "stealth/ox-alpha" });

    const surface = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(surface.status, 200);
    const surfaceBody = (await surface.json()) as { webuiModels: string[]; baseModel: string };
    assert.ok(surfaceBody.webuiModels.includes("stealth/ox-alpha"));
    assert.equal(surfaceBody.baseModel, "stealth/ox-alpha");

    const turn = await srv.built.app.turn({
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "web:alice:openrouter-catalog" },
      text: "hello",
      model: "stealth/ox-alpha",
      async: true,
    });
    assert.equal(turn.status, "queued");
    assert.equal(catalogRequests, 1);
  } finally {
    await srv.close();
  }
});

test("web turns keep a persisted OpenRouter model enabled when the refreshed catalog omits it", async () => {
  const srv = start({ openrouterApiKey: "deployment-openrouter-key" }, async () =>
    Response.json({
      data: [
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Anthropic: Claude Haiku 4.5",
          supported_parameters: ["tools"],
        },
      ],
    }),
  );
  try {
    await srv.built.config.setRuntimeSelection("org:default-org", { modelId: "anthropic/claude-sonnet-4.5" });
    const turn = (threadRef: string, model: string) =>
      srv.built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef },
        text: "hello",
        model,
        async: true,
      });

    const persisted = await turn("web:alice:persisted-openrouter-model", "anthropic/claude-sonnet-4.5");
    assert.equal(persisted.status, "queued");

    await srv.built.config.setRuntimeSelection("personal:alice", { modelId: "openai/gpt-oss-20b:free" });
    const arbitrary = await turn("web:alice:arbitrary-openrouter-model", "openai/gpt-oss-20b:free");
    assert.equal(arbitrary.status, "refused");
    assert.match(arbitrary.reason ?? "", /not enabled for the web UI/);
  } finally {
    await srv.close();
  }
});

test("an oversized OpenRouter catalog falls back to the built-in models", async () => {
  const srv = start({ openrouterApiKey: "deployment-openrouter-key" }, async () =>
    Response.json({
      data: [
        {
          id: "anthropic/claude-sonnet-4.5",
          name: `Anthropic: Claude Sonnet 4.5${"x".repeat(2_100_000)}`,
          supported_parameters: ["tools"],
        },
      ],
    }),
  );
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const models = (
      (await response.json()) as {
        models: Array<{ id: string; provider: string }>;
      }
    ).models;
    assert.ok(!models.some((model) => model.id === "anthropic/claude-sonnet-4.5"));
    assert.ok(models.some((model) => model.id === "openrouter/auto"));
  } finally {
    await srv.close();
  }
});

test("admin scope keeps the selected runtime model visible when its provider is unavailable", async () => {
  const srv = start();
  try {
    await srv.built.config.setRuntimeSelection("org:default-org", { modelId: "claude-opus-5" });
    const response = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      runtime: { modelId: string };
      baseModelOptions: Array<{ id: string }>;
    };
    assert.deepEqual(data.runtime, { modelId: "claude-opus-5", orgRevision: 1, revision: 1 });
    assert.deepEqual(data.baseModelOptions, [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        provider: "anthropic",
      },
    ]);
  } finally {
    await srv.close();
  }
});

test("web turns refuse a model whose provider has no key", async () => {
  const srv = start();
  try {
    const unkeyed = await srv.built.app.turn({
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "web:alice:unkeyed" },
      text: "hello",
      async: true,
      model: "gpt-5.6-sol",
    });
    assert.equal(unkeyed.status, "refused");
    assert.match(unkeyed.reason ?? "", /provider isn't configured/);
  } finally {
    await srv.close();
  }
});

test("a rejected rotation preserves the prior key and disabling suppresses environment fallback", async () => {
  let accepts = true;
  const srv = start(
    { anthropicApiKey: "deployment-anthropic-key" },
    async () => new Response(null, { status: accepts ? 200 : 401 }),
  );
  try {
    const save = (apiKey: string) =>
      fetch(`${srv.base}/v1/admin/model-providers/anthropic`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ apiKey }),
      });
    assert.equal((await save("working-admin-key")).status, 200);
    accepts = false;
    assert.equal((await save("rejected-admin-key")).status, 400);
    assert.equal(await srv.built.modelCredentials.resolve("anthropic"), "working-admin-key");

    const disabled = await fetch(`${srv.base}/v1/admin/model-providers/anthropic`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(disabled.status, 200);
    assert.equal(await srv.built.modelCredentials.resolve("anthropic"), null);
    const status = (await srv.built.modelCredentials.statuses()).find((item) => item.provider === "anthropic")!;
    assert.equal(status.configured, false);
    assert.equal(status.source, "admin");
    assert.equal(status.updatedBy, "admin-alice");
  } finally {
    await srv.close();
  }
});

test("surface-config reports whether any model provider is configured", async () => {
  const srv = start();
  try {
    const before = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, false);

    await srv.built.modelCredentials.set("anthropic", "working-admin-key", "admin-alice@default-org");
    const after = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(((await after.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, true);
  } finally {
    await srv.close();
  }
});

test("surface-config respects an admin-disabled environment provider", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    const before = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(((await before.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, true);
    const disabled = await fetch(`${srv.base}/v1/admin/model-providers/anthropic`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(disabled.status, 200);
    const after = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(((await after.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, false);
  } finally {
    await srv.close();
  }
});

test("surface-config reports company ChatGPT OAuth without making it a Pi API credential", async () => {
  const srv = start({ codexAuthCredential: "company-chatgpt" });
  try {
    const surface = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(surface.status, 200);
    assert.equal(((await surface.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, true);
  } finally {
    await srv.close();
  }
});

test("a company Claude subscription credential is reported as company subscription auth", async () => {
  const srv = start({ claudeAuthCredential: "cred-claude" });
  try {
    const surface = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(surface.status, 200);
    assert.equal(((await surface.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, true);

    const providers = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(providers.status, 200);
    const body = (await providers.json()) as { subscriptionAuth?: { provider: string } };
    assert.deepEqual(body.subscriptionAuth, { provider: "anthropic" });
  } finally {
    await srv.close();
  }
});

test("admin model credentials survive a second app instance on the same durable store", async () => {
  const databaseUrl = testDatabaseUrl();
  const first = createModelCredentialStore({ databaseUrl, keyMaterial: () => "shared-model-key" });
  await first.set("openrouter", "durable-openrouter-key", "admin-alice@default-org");

  const second = createModelCredentialStore({ databaseUrl, keyMaterial: () => "shared-model-key" });
  assert.equal(await second.resolve("openrouter"), "durable-openrouter-key");
  assert.doesNotMatch(
    JSON.stringify(await createPgPool(databaseUrl).q(`SELECT * FROM model_credentials`)),
    /durable-openrouter-key/,
  );
  assert.doesNotMatch(JSON.stringify(await second.statuses()), /durable-openrouter-key/);
});

test("a stored scope runtime remains usable outside the legacy configured picker", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    await srv.built.config.setRuntimeSelection("org:default-org", { modelId: "claude-opus-4-8" });
    await srv.built.config.setSetting("webuiModels", ["claude-sonnet-4-6"], "org:default-org");
    await srv.built.config.setRuntimeSelection("personal:alice", { modelId: "claude-haiku-4-5" });
    const turn = (threadRef: string, model?: string) =>
      srv.built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef },
        text: "hello",
        ...(model ? { model } : {}),
        async: true,
      });

    const stale = await turn("web:alice:stale-override");
    assert.equal(stale.status, "queued");

    const explicitOrgDefault = await turn("web:alice:org-default", "claude-opus-4-8");
    assert.equal(explicitOrgDefault.status, "queued");

    await srv.built.config.setRuntimeSelection("personal:alice", null);
    const inherited = await turn("web:alice:inherited");
    assert.equal(inherited.status, "queued");
  } finally {
    await srv.close();
  }
});

test("inbox runtime overrides use the web model allowlist without changing defaults", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    await srv.built.config.setRuntimeSelection("org:default-org", { modelId: "claude-opus-4-8" });
    await srv.built.config.setSetting("webuiModels", ["claude-sonnet-4-6"], "org:default-org");
    const rejected = await srv.built.app.turn({
      surface: "loop",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "loop:test:item:runtime" },
      text: "Make it shorter",
      model: "claude-haiku-4-5",
      async: true,
      origin: { kind: "automation" },
    });
    assert.equal(rejected.status, "refused");
    assert.match(rejected.reason ?? "", /runtime is no longer available/);
    assert.equal((await srv.built.config.getRuntimeSelectionDurable("org:default-org"))?.modelId, "claude-opus-4-8");
    assert.equal(await srv.built.config.getRuntimeSelectionDurable("personal:alice"), null);
  } finally {
    await srv.close();
  }
});

test("company runtime reads exclude personal-only models without changing the regular picker", async () => {
  const srv = start({ anthropicApiKey: undefined, openaiApiKey: undefined });
  try {
    await srv.built.userModelCredentials.setApiKey("alice", "openai", "synthetic-openai");
    await srv.built.config.setPersonalModelAuth("alice", true, "openai");
    const url = `${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`;
    const personal = (await (await fetch(url)).json()) as { models: string[] };
    assert.ok(personal.models.includes("gpt-5.6-terra"));
    const company = (await (await fetch(`${url}&account=company`)).json()) as { models: string[] };
    assert.ok(!company.models.includes("gpt-5.6-terra"));
    assert.deepEqual(await (await fetch(url)).json(), personal);
    assert.equal((await fetch(`${url}&account=unknown`)).status, 400);
    assert.equal(await srv.built.config.getRuntimeSelectionDurable("personal:alice"), null);
  } finally {
    await srv.close();
  }
});
