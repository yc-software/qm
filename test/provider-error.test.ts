import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
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
