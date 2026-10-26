import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProviderBaseUrl, modelGatewayRequest } from "../src/model/provider-endpoints.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { loadConfig } from "../src/config.ts";

const BASE_ENV = {} as NodeJS.ProcessEnv;

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

test("loadConfig accepts a complete model gateway and rejects partial or malformed routing", () => {
  const config = loadConfig({
    ...BASE_ENV,
    MODEL_GATEWAY_URL: "http://gateway.internal:8080/",
    MODEL_GATEWAY_API_KEY: "secret",
    MODEL_GATEWAY_API_KEY_HEADER: "api-key",
    MODEL_GATEWAY_MODELS: "claude-opus-5=router/opus,claude-haiku-4-5=router/haiku",
  });
  assert.deepEqual(config.modelGateway, {
    url: "http://gateway.internal:8080",
    apiKey: "secret",
    apiKeyHeader: "api-key",
    models: { "claude-opus-5": "router/opus", "claude-haiku-4-5": "router/haiku" },
  });
  assert.throws(() => loadConfig({ ...BASE_ENV, MODEL_GATEWAY_URL: "http://gateway.internal" }), /required/);
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        MODEL_GATEWAY_URL: "http://gateway.internal",
        MODEL_GATEWAY_API_KEY: "secret",
        MODEL_GATEWAY_API_KEY_HEADER: "bad header",
        MODEL_GATEWAY_MODELS: "claude-opus-5=router/opus",
      }),
    /HTTP header name/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        MODEL_GATEWAY_URL: "http://gateway.internal",
        MODEL_GATEWAY_API_KEY: "secret",
        MODEL_GATEWAY_API_KEY_HEADER: "api-key",
        MODEL_GATEWAY_MODELS: "claude-opus-5",
      }),
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
