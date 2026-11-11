import test from "node:test";
import assert from "node:assert/strict";
import { createModelRoutes } from "../src/model/model-route.ts";
import { defaultModelForProvider } from "../src/model/pi-models.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

const claude = defaultModelForProvider("anthropic")!;
const gpt = defaultModelForProvider("openai")!;
const routes = (own: string[]) =>
  createModelRoutes({
    defaultModelId: claude,
    modelGateway: {
      url: "http://gateway.invalid",
      apiKey: "k",
      apiKeyHeader: "x-api-key",
      models: { [claude]: claude },
    },
    resolveProviderKeys: async () => ({ anthropic: "env-key", ...Object.fromEntries(own.map((p) => [p, `${p}-key`])) }),
    ownProviders: async () => new Set(own),
  });
const summary = (r: { modelId: string; billing: string; gateway?: unknown }) => [r.modelId, r.billing, !!r.gateway];

test("company inference leaves the gateway once the organization saves its own provider key", async () => {
  assert.deepEqual(summary(await withTenant(TEST_TENANT, () => routes([]).route(claude))), [
    claude,
    "model_gateway",
    true,
  ]);
  assert.deepEqual(summary(await routes(["anthropic"]).route(claude)), [claude, "org_key", false]);
  assert.deepEqual(summary(await routes(["openai"]).route(claude)), [gpt, "org_key", false]);
  const direct = await routes(["openai"]).route("claude-haiku-5-5");
  assert.deepEqual([direct.modelId, direct.billing], ["claude-haiku-5-5", "org_key"]);
  const personal = await routes(["openai"]).route(claude, { anthropic: "mine" });
  assert.deepEqual(summary(personal), [claude, "personal_account", false]);
});
