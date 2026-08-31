import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_GEMINI_COMPAT,
  DEV_GEMINI_PROVIDER_ID,
  DEV_GEMINI_THOUGHT_SIGNATURE,
  devGeminiProviderFromEnv,
  normalizeConfiguredDevGeminiPayload,
  normalizeDevGeminiPayload,
  resolveDevGeminiApiKey,
  takeDevGeminiApiKey,
} from "../src/model/dev-gemini-provider.ts";
import { customModelsJson, resolveCustomModel, setCustomProviders } from "../src/model/custom-providers.ts";

test("the transient key is consumed from process-like environments and rotations never revert", () => {
  const env = { GEMINI_API_KEY: "first-key", KEEP: "value" };
  assert.equal(takeDevGeminiApiKey(env), "first-key");
  assert.deepEqual(env, { KEEP: "value" });
  const rotated = resolveDevGeminiApiKey("first-key", "second-key");
  assert.equal(rotated, "second-key");
  assert.equal(resolveDevGeminiApiKey(rotated, undefined), "second-key");
  assert.equal(resolveDevGeminiApiKey(rotated, ""), "second-key");
});

test("Gemini compatibility removes unsupported fields and restores sequential tool replay authority", () => {
  const normalized = normalizeDevGeminiPayload({
    store: false,
    stream_options: { include_usage: true },
    max_completion_tokens: 4096,
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
          {
            id: "call-2",
            type: "function",
            function: { name: "write", arguments: "{}" },
            extra_content: { google: { thought_signature: "provider-signature" } },
          },
        ],
      },
    ],
  }) as any;
  assert.equal(normalized.store, undefined);
  assert.equal(normalized.stream_options, undefined);
  assert.equal(normalized.max_completion_tokens, undefined);
  assert.equal(normalized.max_tokens, 4096);
  assert.equal(
    normalized.messages[0].tool_calls[0].extra_content.google.thought_signature,
    DEV_GEMINI_THOUGHT_SIGNATURE,
  );
  assert.equal(normalized.messages[0].tool_calls[1].extra_content.google.thought_signature, "provider-signature");
});

test("the compatibility transform requires an active dev-provider binding, not only its public slug", () => {
  const payload = { store: false };
  assert.equal(normalizeConfiguredDevGeminiPayload(payload, DEV_GEMINI_PROVIDER_ID, undefined), payload);
  assert.notEqual(
    normalizeConfiguredDevGeminiPayload(payload, DEV_GEMINI_PROVIDER_ID, DEV_GEMINI_PROVIDER_ID),
    payload,
  );
});

test("the dev provider materializes the exact OpenAI-compatible model quirks", () => {
  const provider = devGeminiProviderFromEnv({
    DEV_INSTANCE_GEMINI_PROVIDER: "1",
    GEMINI_API_KEY: "test-key",
    HARNESS: "pi",
  });
  assert.ok(provider);
  setCustomProviders([provider.spec]);
  try {
    const model = resolveCustomModel(provider.spec.models[0]!.id);
    assert.equal(model?.provider, DEV_GEMINI_PROVIDER_ID);
    assert.deepEqual(model?.compat, DEV_GEMINI_COMPAT);
    const serialized = customModelsJson() as any;
    assert.deepEqual(serialized.providers[DEV_GEMINI_PROVIDER_ID].models[0].compat, DEV_GEMINI_COMPAT);
  } finally {
    setCustomProviders([]);
  }
});
