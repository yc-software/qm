import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { providerTurnError } from "../src/harness/provider-error.ts";

test("vendored pi-ai keeps a LiteLLM 429 budget_exceeded as structured providerError", async (t) => {
  const body = {
    error: {
      message: "Budget has been exceeded! Current cost: 5.1, Max budget: 5.0",
      type: "budget_exceeded",
      param: null,
      code: "400",
    },
  };
  const server = createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const model = {
    id: "litellm-model",
    name: "litellm-model",
    api: "openai-completions",
    provider: "litellm",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  } as Model<"openai-completions">;

  const failed = await stream(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      apiKey: "test-key",
      maxRetries: 0,
    },
  ).result();

  assert.equal(failed.stopReason, "error");
  assert.deepEqual(failed.providerError, { status: 429, type: "budget_exceeded", code: "400", body: body.error });
  assert.match(failed.errorMessage ?? "", /^429: /, "errorMessage keeps stock pi-ai formatting");
  const err = providerTurnError(failed);
  assert.deepEqual([err.code, err.status, err.retryable], ["model_budget", 429, false]);
});

test("providerTurnError maps documented status, type and code without reading errorMessage", () => {
  const failed = (providerError: AssistantMessage["providerError"], rawStopReason?: string) =>
    ({
      role: "assistant",
      stopReason: "error",
      errorMessage: "429 budget refusal timeout",
      providerError,
      rawStopReason,
    }) as AssistantMessage;
  for (const [message, code, retryable] of [
    [failed({ status: 429, type: "budget_exceeded" }), "model_budget", false],
    [failed({ status: 429, code: "insufficient_quota" }), "model_budget", false],
    [failed({ status: 400, code: "context_length_exceeded" }), "context_too_long", false],
    [failed({ status: 401, type: "authentication_error" }), "auth", false],
    [failed({ status: 429, type: "rate_limit_error" }), "rate_limit", true],
    [failed({ status: 404, type: "not_found_error" }), "not_found", false],
    [failed({ status: 404, code: "model_not_found" }), "not_found", false],
    [failed({ status: 400, type: "invalid_request_error" }), "bad_request", false],
    [failed({ status: 422 }), "bad_request", false],
    [failed({ status: 529, type: "overloaded_error" }), "transient", true],
    [failed({ status: 503, type: "invalid_request_error" }), "transient", true],
    [failed(undefined, "refusal"), "refusal", false],
    [failed(undefined), "unknown", true],
  ] as const) {
    const error = providerTurnError(message);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal(error.raw, "429 budget refusal timeout");
  }
});
