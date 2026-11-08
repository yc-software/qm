import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { providerTurnError } from "../src/model/provider-error.ts";
import { turnFailureMessage } from "../src/core/turn-error.ts";

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

async function failedThrough<A extends "openai-completions" | "anthropic-messages">(
  t: { after(fn: () => void): void },
  api: A,
  respond: (res: import("node:http").ServerResponse) => void,
): Promise<AssistantMessage> {
  const server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const model = {
    id: "claude-opus-4-8",
    name: "test-model",
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: api === "anthropic-messages" ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  } as Model<A>;
  const run = {
    "openai-completions": stream,
    "anthropic-messages": anthropicStream,
  }[api] as (m: Model<A>, c: unknown, o: unknown) => { result(): Promise<AssistantMessage> };
  const failed = await run(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    { apiKey: "test-key", maxRetries: 0 },
  ).result();
  assert.equal(failed.stopReason, "error");
  return failed;
}

const json = (status: number, body: unknown) => (res: import("node:http").ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("a 402 billing_error from the key's provider is an account failure with a plain notice", async (t) => {
  const reason =
    "Billing account is not in good standing for this request. Add credits or resolve the billing issue before retrying.";
  const failed = await failedThrough(
    t,
    "openai-completions",
    json(402, { error: { message: reason, type: "billing_error", code: "insufficient_credits" } }),
  );
  const err = providerTurnError(failed);
  assert.deepEqual([err.code, err.status, err.retryable], ["account", 402, false]);
  assert.equal(
    turnFailureMessage(err),
    `The model key for Claude Opus 4.8 was refused by the provider ("Model provider API error (billing_error): ${reason}"). Whoever owns that key needs to fix its billing or access, or replace it.`,
  );
});

test("Anthropic's low credit balance is an account failure, other invalid requests stay bad_request", async (t) => {
  const lowCredit = await failedThrough(
    t,
    "anthropic-messages",
    json(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    }),
  );
  assert.deepEqual([providerTurnError(lowCredit).code, providerTurnError(lowCredit).retryable], ["account", false]);
  const malformed = await failedThrough(
    t,
    "anthropic-messages",
    json(400, { type: "error", error: { type: "invalid_request_error", message: "messages: field required" } }),
  );
  assert.equal(providerTurnError(malformed).code, "bad_request");
});

test("Anthropic's refusal stop reason stays a refusal and quotes its explanation", async (t) => {
  const explanation =
    "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const failed = await failedThrough(t, "anthropic-messages", (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage } },
      {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { explanation } },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  const err = providerTurnError(failed);
  assert.deepEqual([err.code, err.retryable], ["refusal", false]);
  assert.equal(
    turnFailureMessage(err),
    `Claude Opus 4.8 declined this request under the provider's usage policy ("${explanation}"). Rephrase, or switch model.`,
  );
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
    [failed({ status: 429, code: "insufficient_quota" }), "account", false],
    [failed({ status: 400, code: "context_length_exceeded" }), "context_too_long", false],
    [failed({ status: 401, type: "authentication_error" }), "auth", false],
    [failed({ status: 400, code: "cyber_policy" }), "refusal", false],
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

function failedWith(providerError: AssistantMessage["providerError"]): AssistantMessage {
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
  } as AssistantMessage;
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
