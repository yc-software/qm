import test from "node:test";
import assert from "node:assert/strict";
import { createModelRoutes } from "../src/model/model-route.ts";
import { moveGatewayDefaultsToProvider } from "../src/model/own-provider-defaults.ts";
import { defaultModelForProvider } from "../src/model/pi-models.ts";
import type { ScopedConfigStore } from "../src/resolution/config-store.ts";
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
    resolveProviderKeys: async () => Object.fromEntries(own.map((p) => [p, `${p}-key`])),
    ownProviders: async () => new Set(own),
  });
const summary = (r: { modelId: string; billing: string }) => [r.modelId, r.billing];

test("a plain model id uses the organization's own key for its provider; other gateway models stay on the gateway", async () => {
  assert.deepEqual(summary(await withTenant(TEST_TENANT, () => routes([]).route(claude))), [claude, "model_gateway"]);
  assert.deepEqual(summary(await routes(["anthropic"]).route(claude)), [claude, "org_key"]);
  assert.deepEqual(summary(await routes(["openai"]).route(claude)), [claude, "model_gateway"]);
  assert.deepEqual(summary(await routes(["openai"]).route(claude, { anthropic: "mine" })), [
    claude,
    "personal_account",
  ]);
});

test("saving a key for another provider moves the defaults that ran on the gateway", async () => {
  const store = new Map<string, { modelId: string }>([
    ["fallback", { modelId: claude }],
    ["cron", { modelId: gpt }],
  ]);
  const config = {
    getRuntimeSelectionDurable: async () => store.get("base") ?? null,
    setRuntimeSelection: async (_: string, s: { modelId: string }) => void store.set("base", s),
    getPurposeRuntimeDurable: async (p: string) => store.get(p),
    setPurposeRuntime: async (p: string, s: { modelId: string }) => void store.set(p, s),
  } as unknown as ScopedConfigStore;
  const moved = await withTenant(TEST_TENANT, () =>
    moveGatewayDefaultsToProvider(config, routes(["openai"]), "openai", "org:o"),
  );
  assert.deepEqual(moved, [
    { setting: "base-model", from: claude, to: gpt },
    { setting: "fallback-runtime", from: claude, to: gpt },
  ]);
  assert.equal(store.get("cron")?.modelId, gpt);
});
