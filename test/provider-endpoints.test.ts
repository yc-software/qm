import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseProviderBaseUrl,
  providerBaseUrl,
  modelGatewayRequest,
  setProviderBaseUrls,
} from "../src/model/provider-endpoints.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { createTenantModels } from "../src/model/tenant-models.ts";
import { withTenant } from "../src/tenants/context.ts";
import { parseTenantSettings } from "../src/tenants/settings-parse.ts";
import { TEST_TENANT, testTenantSettings } from "./support/build-app.ts";

const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

function tenantTest(name: string, fn: () => void | Promise<void>): void {
  test(name, () => withTenant(TEST_TENANT, fn));
}

afterEach(() => {
  setProviderBaseUrls(TEST_TENANT, {});
});

test("parseProviderBaseUrl normalizes trailing slashes and whitespace", () => {
  assert.equal(parseProviderBaseUrl("X", " https://gw.example.com/v1// "), "https://gw.example.com/v1");
});

test("parseProviderBaseUrl rejects bad values", () => {
  assert.throws(() => parseProviderBaseUrl("X", "not a url"));
  assert.throws(() => parseProviderBaseUrl("X", "ftp://gw.example.com"));
  assert.throws(() => parseProviderBaseUrl("X", "https://user:pw@gw.example.com"));
  assert.throws(() => parseProviderBaseUrl("X", "https://gw.example.com/?a=b"));
  assert.throws(() => parseProviderBaseUrl("X", "https://gw.example.com/#frag"));
});

test("tenant settings read the provider base URL variables", () => {
  const { providerBaseUrls } = parseTenantSettings(
    { ANTHROPIC_BASE_URL: "https://a.example.com", OPENAI_BASE_URL: "https://o.example.com/v1/" },
    "pi",
  );
  assert.deepEqual(providerBaseUrls, { anthropic: "https://a.example.com", openai: "https://o.example.com/v1" });
});

tenantTest("providerBaseUrl answers only for configured, known providers of the bound tenant", () => {
  setProviderBaseUrls(TEST_TENANT, { anthropic: "https://a.example.com" });
  assert.equal(providerBaseUrl("anthropic"), "https://a.example.com");
  assert.equal(providerBaseUrl("openai"), undefined);
  assert.equal(providerBaseUrl("weird"), undefined);
  assert.equal(
    withTenant(OTHER_TENANT, () => providerBaseUrl("anthropic")),
    undefined,
  );
});

tenantTest("resolveModel routes a built-in model through the override", () => {
  assert.equal(resolveModel("claude-opus-4-8")?.baseUrl, "https://api.anthropic.com");
  setProviderBaseUrls(TEST_TENANT, { anthropic: "https://gw.example.com" });
  assert.equal(resolveModel("claude-opus-4-8")?.baseUrl, "https://gw.example.com");
  assert.equal(resolveModel("gpt-5.6-sol")?.baseUrl, "https://api.openai.com/v1");
});

tenantTest("a cloned model follows its template's override", () => {
  setProviderBaseUrls(TEST_TENANT, { anthropic: "https://gw.example.com" });
  const clone = resolveModel("claude-opus-5");
  assert.equal(clone?.baseUrl, "https://gw.example.com");
  assert.equal(clone?.id, "claude-opus-5");
});

test("loadConfig parses provider base URLs", () => {
  const config = loadConfig({
    ...BASE_ENV,
    ANTHROPIC_BASE_URL: "https://a.example.com/",
    OPENAI_BASE_URL: "https://o.example.com/v1",
  });
  assert.deepEqual((await settings.get()).providerBaseUrls, {
    anthropic: "https://a.example.com",
    openai: "https://o.example.com/v1",
  });
});

test("tenant settings reject an invalid provider base URL", () => {
  assert.throws(() => parseTenantSettings({ OPENAI_BASE_URL: "nope" }, "pi"));
});

test("loadConfig leaves provider base URLs empty when no override is set", () => {
  assert.deepEqual(loadConfig(BASE_ENV).providerBaseUrls, {});
});

test("tenant settings accept a complete model gateway and reject partial or malformed routing", () => {
  const settings = parseTenantSettings(
    {
      MODEL_GATEWAY_URL: "http://gateway.internal:8080/",
      MODEL_GATEWAY_API_KEY: "secret",
      MODEL_GATEWAY_API_KEY_HEADER: "api-key",
      MODEL_GATEWAY_MODELS: "claude-opus-5=router/opus,claude-haiku-4-5=router/haiku",
    },
    "pi",
  );
  assert.deepEqual(settings.modelGateway, {
    url: "http://gateway.internal:8080",
    apiKey: "secret",
    apiKeyHeader: "api-key",
    models: { "claude-opus-5": "router/opus", "claude-haiku-4-5": "router/haiku" },
  });
  assert.throws(() => parseTenantSettings({ MODEL_GATEWAY_URL: "http://gateway.internal" }, "pi"), /required/);
  assert.throws(
    () =>
      parseTenantSettings(
        {
          MODEL_GATEWAY_URL: "http://gateway.internal",
          MODEL_GATEWAY_API_KEY: "secret",
          MODEL_GATEWAY_API_KEY_HEADER: "bad header",
          MODEL_GATEWAY_MODELS: "claude-opus-5=router/opus",
        },
        "pi",
      ),
    /HTTP header name/,
  );
  assert.throws(
    () =>
      parseTenantSettings(
        {
          MODEL_GATEWAY_URL: "http://gateway.internal",
          MODEL_GATEWAY_API_KEY: "secret",
          MODEL_GATEWAY_API_KEY_HEADER: "api-key",
          MODEL_GATEWAY_MODELS: "claude-opus-5",
        },
        "pi",
      ),
    /invalid MODEL_GATEWAY_MODELS/,
  );
});

test("gateway-mapped built-in models send session-affinity headers", () => {
  const gateway = {
    url: "http://gateway.internal/v1",
    apiKey: "k",
    apiKeyHeader: "x-gateway-key",
    models: { "claude-opus-5-5": "router/claude-opus-5-5", "gpt-5.6-sol": "router/gpt-5.6-sol" },
  };
  for (const id of Object.keys(gateway.models)) {
    const model = resolveModel(id)!;
    const routed = modelGatewayRequest(gateway, model)!;
    assert.equal(
      (routed.model.compat as { sendSessionAffinityHeaders?: boolean } | undefined)?.sendSessionAffinityHeaders,
      true,
    );
    assert.equal(routed.model.baseUrl, gateway.url);
    assert.equal(routed.model.id, model.id);
  }
});
