import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelRuntime } from "../src/model/model-runtime.ts";

test("gateway-served providers pass the auth check used for mid-turn model switches", async () => {
  const runtime = await buildModelRuntime(
    {},
    {
      url: "https://gateway.invalid",
      apiKey: "test-gateway-key",
      apiKeyHeader: "x-test-key",
      models: { "claude-opus-4-5": "anthropic/claude-opus-4-5", "gpt-5": "openai/gpt-5" },
    },
  );
  for (const provider of ["anthropic", "openai"]) {
    assert.ok(runtime.hasConfiguredAuth(provider), provider);
    assert.equal((await runtime.checkAuth(provider))?.source, "model gateway", provider);
  }
  assert.equal(await runtime.checkAuth("openrouter"), undefined);
});
