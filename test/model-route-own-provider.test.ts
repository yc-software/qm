import test from "node:test";
import assert from "node:assert/strict";
import { createModelRoutes } from "../src/model/model-route.ts";
import { defaultModelForProvider } from "../src/model/pi-models.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

const claude = defaultModelForProvider("anthropic")!;
const gpt = defaultModelForProvider("openai")!;

function routes(own: string[]) {
  return createModelRoutes({
    defaultModelId: claude,
    modelGateway: {
      url: "http://gateway.invalid",
      apiKey: "gateway-key",
      apiKeyHeader: "x-api-key",
      models: { [claude]: `anthropic/${claude}`, [gpt]: `openai/${gpt}` },
    },
    resolveProviderKeys: async () => Object.fromEntries(own.map((provider) => [provider, `${provider}-key`])),
    ownProviders: async () => new Set(own),
  });
}

test("company inference stays on the gateway until an admin adds the company's own provider", async () => {
  const route = await withTenant(TEST_TENANT, () => routes([]).route(claude));
  assert.equal(route.billing, "model_gateway");
  assert.ok(route.gateway);
});

test("a company's own provider key takes over its models from the gateway", async () => {
  const route = await routes(["anthropic"]).route(claude);
  assert.deepEqual([route.modelId, route.billing, route.gateway], [claude, "org_key", undefined]);
  assert.equal(route.keys.anthropic, "anthropic-key");
});

test("models from a provider the company has no key for move to its own provider's default model", async () => {
  const route = await routes(["openai"]).route(claude);
  assert.deepEqual([route.modelId, route.billing, route.gateway], [gpt, "org_key", undefined]);
  const utility = await routes(["openai"]).utility();
  assert.equal(utility?.billing, "org_key");
});

test("a gateway-catalog model id resolves to the provider's own model once the company has that provider", async () => {
  const route = await routes(["anthropic"]).route(`gateway/anthropic/${claude}`);
  assert.deepEqual([route.modelId, route.billing], [claude, "org_key"]);
});

test("personal accounts are unaffected by the company's provider choice", async () => {
  const route = await routes(["openai"]).route(claude, { anthropic: "personal-key" });
  assert.deepEqual([route.modelId, route.billing, route.keys.anthropic], [claude, "personal_account", "personal-key"]);
});
