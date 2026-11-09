import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CapturedAssistantMessage, ProviderErrorInfo } from "../src/model/provider-capture.ts";
import { buildModelRuntime } from "../src/model/model-runtime.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { providerTurnError } from "../src/model/provider-error.ts";

async function serve(t: test.TestContext, reply: (res: ServerResponse) => void): Promise<string> {
  const server = createServer((_req, res) => reply(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function failedCall(model: Model<Api>, provider: string): Promise<CapturedAssistantMessage> {
  const runtime = await buildModelRuntime({ [provider]: "test-key" });
  return runtime
    .streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { maxRetries: 0 })
    .result();
}

test("a LiteLLM 429 budget_exceeded keeps its status, type, code and body as providerError", async (t) => {
  const body = {
    error: {
      message: "Budget has been exceeded! Current cost: 5.1, Max budget: 5.0",
      type: "budget_exceeded",
      param: null,
      code: "400",
    },
  };
  const url = await serve(t, (res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const model = {
    id: "litellm-model",
    name: "litellm-model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: `${url}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  } as Model<Api>;

  const failed = await failedCall(model, "openai");

  assert.equal(failed.stopReason, "error");
  assert.deepEqual(failed.providerError, { status: 429, type: "budget_exceeded", code: "400", body: body.error });
  assert.match(failed.errorMessage ?? "", /\(429\): /);
  const err = providerTurnError(failed);
  assert.deepEqual([err.code, err.status, err.retryable], ["model_budget", 429, false]);
});

test("an Anthropic error event mid-stream keeps its error type as providerError", async (t) => {
  const url = await serve(t, (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const start = {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    };
    const error = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    res.end(`event: message_start\ndata: ${JSON.stringify(start)}\n\nevent: error\ndata: ${JSON.stringify(error)}\n\n`);
  });
  const model = { ...getRequiredModel("claude-opus-5"), baseUrl: url } as Model<Api>;

  const failed = await failedCall(model, "anthropic");

  assert.equal(failed.stopReason, "error");
  assert.deepEqual(failed.providerError, {
    type: "overloaded_error",
    body: { type: "overloaded_error", message: "Overloaded" },
  });
  const err = providerTurnError(failed);
  assert.deepEqual(
    [err.code, err.retryable, err.message],
    ["transient", true, "Model provider API error (overloaded_error): Overloaded"],
  );
});

test("providerTurnError maps documented status, type and code without reading errorMessage", () => {
  const failed = (providerError: ProviderErrorInfo | undefined, rawStopReason?: string) =>
    ({
      role: "assistant",
      stopReason: "error",
      errorMessage: "429 budget refusal timeout",
      providerError,
      rawStopReason,
    }) as CapturedAssistantMessage;
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

function failedWith(providerError: ProviderErrorInfo | undefined): CapturedAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "irrelevant text",
    timestamp: 0,
    ...(providerError ? { providerError } : {}),
  } as CapturedAssistantMessage;
}

test("gateway model_unavailable is its own code so the turn falls back", () => {
  assert.equal(providerTurnError(failedWith({ status: 404, type: "model_unavailable" })).code, "model_unavailable");
});

test("over-window prompts classify as context_too_long from structured signals", () => {
  assert.equal(providerTurnError(failedWith({ status: 413, type: "request_too_large" })).code, "context_too_long");
  const anthropic400 = failedWith({ status: 400, type: "invalid_request_error" });
  assert.equal(
    providerTurnError(anthropic400, { contextWindow: 200_000, lastInputTokens: 195_000 }).code,
    "context_too_long",
  );
  assert.equal(
    providerTurnError(anthropic400, { contextWindow: 200_000, lastInputTokens: 20_000 }).code,
    "bad_request",
  );
});
