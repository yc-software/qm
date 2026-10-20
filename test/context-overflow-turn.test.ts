import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { verificationUpstream } from "./support/model-verification-upstream.ts";

// Anthropic reports prompt-too-long as a plain 400 invalid_request_error. Mid tool loop, the
// turn must reduce context and finish, without repeating the tool call it already made.
for (const priorInputTokens of [190_000, 60_000]) {
  test(`a 400 prompt-too-long after a tool call (prior input ${priorInputTokens}) recovers once`, async () => {
    const upstream = await verificationUpstream();
    let remembers = 0;
    let overflowed = false;
    upstream.behavior.script = (body) => {
      const text = JSON.stringify(body.messages ?? []);
      if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: "Title" };
      if (text.includes("Remembered 1 fact") && !overflowed) {
        overflowed = true;
        return { status: 400, message: "prompt is too long: 203512 tokens > 200000 maximum" };
      }
      if (text.includes("Remembered 1 fact") || overflowed) return { text: "DONE" };
      remembers++;
      return {
        inputTokens: priorInputTokens,
        toolUse: { name: "memory", input: { action: "remember", facts: ["overflow fact"] } },
      };
    };
    const built = buildApp(
      testConfig({
        harness: "pi",
        modelId: "claude-haiku-4-5",
        anthropicApiKey: "test-key",
        providerBaseUrls: { anthropic: upstream.url },
      }),
    );
    try {
      const result = await built.app.turn({
        surface: "test",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `dm:U1:overflow-${priorInputTokens}` },
        text: "remember something",
      });
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal((result as { reply?: string }).reply, "DONE");
      assert.equal(overflowed, true);
      assert.equal(remembers, 1, "the tool call is not repeated after context recovery");
    } finally {
      await upstream.close();
    }
  });
}
