import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeEndpoint } from "./live-slack/harness.ts";

test("the live judge calls Anthropic directly with a provider key", () => {
  assert.deepEqual(judgeEndpoint({ ANTHROPIC_API_KEY: "direct-key" }, "claude-haiku-5-5"), {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "direct-key" },
    model: "claude-haiku-5-5",
  });
});

test("the live judge routes through a configured model gateway instead of the provider key", () => {
  const env = {
    ANTHROPIC_API_KEY: "direct-key",
    MODEL_GATEWAY_URL: "http://gateway.test:8080/",
    MODEL_GATEWAY_API_KEY: "gateway-key",
    MODEL_GATEWAY_API_KEY_HEADER: "api-key",
    MODEL_GATEWAY_MODELS: "claude-haiku-5-5=router/claude-haiku-latest",
  };
  const endpoint = judgeEndpoint(env, "claude-haiku-5-5");
  assert.equal(new URL(endpoint.url).pathname, "/v1/messages");
  assert.equal(new URL(endpoint.url).host, "gateway.test:8080");
  assert.deepEqual(endpoint.headers, { "api-key": "gateway-key" });
  assert.equal(endpoint.model, "router/claude-haiku-latest");
  assert.throws(() => judgeEndpoint(env, "claude-unrouted"), /no route for judge model claude-unrouted/);
});

test("the live judge requires a provider key or a model gateway", () => {
  assert.throws(() => judgeEndpoint({}, "claude-haiku-5-5"), /ANTHROPIC_API_KEY or MODEL_GATEWAY_URL is required/);
});
