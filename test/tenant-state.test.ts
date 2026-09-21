import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantContext, currentTenant, runWithTenant, tenantEnv, tenantState } from "../src/tenancy/context.ts";
import { orgId, orgScope } from "../src/config.ts";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";
import { setProviderBaseUrls, providerBaseUrl } from "../src/model/provider-endpoints.ts";
import { setCustomProviders, customProvidersVersion, resolveCustomModel } from "../src/model/custom-providers.ts";
import { setGatewayModels, gatewayModelsVersion, type GatewayModel } from "../src/model/gateway-models.ts";
import { setModelOverlays, modelOverlayVersion, resolveModel } from "../src/model/pi-models.ts";
import { selectableModelCatalog } from "../src/model/model-catalog.ts";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { estimateEntryTokens } from "../src/harness/context-compaction.ts";
import { countTokens } from "../src/util/tokens.ts";
import { setDefaultBotIdentity, botIdentityArgs } from "../src/slack/delivery.ts";
import { setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { localContainerName, localVolumeName } from "../src/sandbox/local-sandbox.ts";
import type { SessionEntry } from "../src/types.ts";

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("tenant context keeps immutable environment and mutable cells isolated across asynchronous work", async () => {
  const key = Symbol("test-state");
  const env = { API_KEY: "a-secret" };
  const a = createTenantContext({ id: "tenant-a", env, pooled: true });
  const b = createTenantContext({ id: "tenant-b", env: { API_KEY: "b-secret" }, pooled: true });
  env.API_KEY = "changed";
  assert.equal(a.env.API_KEY, "a-secret");
  assert.ok(Object.isFrozen(a.env));
  assert.ok(Object.isFrozen(a));
  assert.throws(() => createTenantContext({ id: "tenant-a", env: { ORG_ID: "tenant-b" } }), /match ORG_ID/);
  await Promise.all(
    [a, b].map((tenant) =>
      runWithTenant(tenant, async () => {
        const state = tenantState(key, () => ({ value: tenant.id }));
        const source = createEnvSecretSource();
        await yieldTurn();
        assert.equal(currentTenant(), tenant);
        assert.equal(orgId(), tenant.id);
        assert.equal(orgScope(), `org:${tenant.id}`);
        assert.equal(
          tenantState(key, () => ({ value: "wrong" })),
          state,
        );
        assert.equal(state.value, tenant.id);
        assert.equal(await source.get("API_KEY"), tenant.env.API_KEY);
        runWithTenant(tenant === a ? b : a, () => assert.notEqual(currentTenant(), tenant));
        assert.equal(currentTenant(), tenant);
      }),
    ),
  );
  assert.equal(currentTenant(), undefined);
  assert.equal(tenantEnv(), process.env);
  assert.deepEqual(
    tenantState(key, () => ({ value: "legacy" })),
    { value: "legacy" },
  );
});

test("same model ids and matching version counters cannot share endpoints, catalogs or runtime model files", async () => {
  const contexts = ["a", "b"].map((id) => createTenantContext({ id, env: {}, pooled: true }));
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [] }));
  await Promise.all(
    contexts.map((context) =>
      runWithTenant(context, async () => {
        const endpoint = `https://${context.id}.example.com/v1`;
        setProviderBaseUrls({ openai: endpoint });
        setCustomProviders([
          {
            id: "company",
            name: context.id,
            protocol: "openai",
            baseUrl: endpoint,
            models: [{ id: "shared-model", name: context.id }],
          },
        ]);
        setGatewayModels([
          {
            ...resolveModel("gpt-5.5")!,
            id: "gateway/shared-model",
            name: `gateway-${context.id}`,
            provider: "qm:gateway",
            baseUrl: endpoint,
          } as GatewayModel,
        ]);
        setModelOverlays([
          {
            id: "company-overlay",
            name: `overlay-${context.id}`,
            provider: "openai",
            template: "gpt-5.5",
            contextWindow: 200_000,
            maxTokens: 10_000,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ]);
        await yieldTurn();
        assert.equal(customProvidersVersion(), 1);
        assert.equal(gatewayModelsVersion(), 1);
        assert.equal(modelOverlayVersion(), 2);
        assert.equal(providerBaseUrl("openai"), endpoint);
        assert.equal(resolveCustomModel("shared-model")?.baseUrl, endpoint);
        assert.equal(resolveModel("gateway/shared-model")?.baseUrl, endpoint);
        assert.equal(resolveModel("company-overlay")?.name, `overlay-${context.id}`);
        const first = await selectableModelCatalog(fetcher);
        await yieldTurn();
        const cached = await selectableModelCatalog(fetcher);
        assert.equal(first, cached);
        assert.equal(cached.find((model) => model.id === "shared-model")?.name, context.id);
        assert.equal(cached.find((model) => model.id === "gateway/shared-model")?.name, `gateway-${context.id}`);
        const runtime = await buildModelRuntime({ company: "test-key" });
        const model = runtime.getModel("company", "shared-model");
        assert.equal(model?.baseUrl, endpoint);
        assert.equal(runtime.getModel("qm:gateway", "gateway/shared-model")?.baseUrl, endpoint);
      }),
    ),
  );
  assert.equal(resolveCustomModel("shared-model"), undefined);
});

test("same Slack names and session identifiers retain tenant-specific values", async () => {
  const texts = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Hello world! foo bar baz qux xyz"];
  assert.equal(texts[0]!.length, texts[1]!.length);
  assert.notEqual(countTokens(texts[0]!), countTokens(texts[1]!));
  await Promise.all(
    ["a", "b"].map((id, index) =>
      runWithTenant(createTenantContext({ id, env: {}, pooled: true }), async () => {
        setDefaultBotIdentity({ username: id });
        setMentionIndex(new Map([["alex", `U${id.toUpperCase()}`]]));
        const entry = {
          sessionId: "same-session",
          seq: 1,
          type: "user",
          payload: { text: texts[index] },
        } as SessionEntry;
        const expected = countTokens(texts[index]!);
        assert.equal(estimateEntryTokens(entry), expected);
        await yieldTurn();
        assert.equal(botIdentityArgs().username, id);
        assert.equal(toSlackMrkdwn("Hello @alex"), `Hello <@U${id.toUpperCase()}>`);
        assert.equal(estimateEntryTokens(entry), expected);
      }),
    ),
  );
});

test("local Docker scope names differ across pooled tenants and preserve legacy names otherwise", () => {
  const scope = "personal:same@example.com";
  const legacy = [localContainerName(scope), localVolumeName(scope)];
  const names = ["a", "b"].map((id) =>
    runWithTenant(createTenantContext({ id, env: {}, pooled: true }), () => [
      localContainerName(scope),
      localVolumeName(scope),
    ]),
  );
  assert.notDeepEqual(names[0], names[1]);
  assert.notDeepEqual(names[0], legacy);
  assert.deepEqual(
    runWithTenant(createTenantContext({ id: "a", env: {} }), () => [localContainerName(scope), localVolumeName(scope)]),
    legacy,
  );
});

test("pooled model runtimes never use a provider credential from the host environment", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "host-only-secret";
  try {
    const context = createTenantContext({ id: "no-key", env: {}, pooled: true });
    await runWithTenant(context, async () => {
      const runtime = await buildModelRuntime({});
      assert.equal(runtime.hasConfiguredAuth("openai"), false);
      assert.equal(await runtime.getAuth("openai"), undefined);
      assert.equal(await runtime.getAuth(resolveModel("gpt-5.5")!), undefined);
      const configured = await buildModelRuntime({ openai: "tenant-only-secret" });
      assert.equal(configured.hasConfiguredAuth("openai"), true);
      assert.equal((await configured.getAuth("openai"))?.auth.apiKey, "tenant-only-secret");
      const gateway = await buildModelRuntime(
        {},
        {
          url: "https://tenant.example.com/v1",
          apiKey: "gateway-only-secret",
          apiKeyHeader: "Authorization",
          models: { "gpt-5.5": "tenant-model" },
        },
      );
      assert.equal(gateway.hasConfiguredAuth("openai"), true);
      assert.equal((await gateway.getAuth(resolveModel("gpt-5.5")!))?.auth.apiKey, "gateway-only-secret");
    });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
