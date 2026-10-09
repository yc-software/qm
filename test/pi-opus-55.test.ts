import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { buildModelRuntime, probeModel } from "../src/harness/pi-harness.ts";
import { getRequiredModel, modelSupportsFastMode } from "../src/model/pi-models.ts";

const bindingBeta = "thinking-binding-controls-2026-08-01";
const context = { messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 0 }] };

for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5"])
  test(`${modelId} wire requests keep mandatory thinking, caller hooks and beta headers across Pi entry points`, (t) =>
    assertMandatoryThinkingWire(t, modelId));

test("claude-haiku-5-5 wire requests bind adaptive thinking at every effort and turn thinking off only without one", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return okStream("claude-haiku-5-5");
  }) as typeof fetch;
  const model = getRequiredModel("claude-haiku-5-5", false);
  const runtime = await buildModelRuntime({ anthropic: "sk-offline-test-key" });
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const response = await runtime.streamSimple(model, context, { reasoning: effort, maxRetries: 0 }).result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    const request = requests.at(-1)!;
    assert.ok(request.headers.get("anthropic-beta")?.includes(bindingBeta));
    assert.deepEqual(request.body.thinking, {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    assert.deepEqual(request.body.output_config, { effort });
    assert.equal(request.body.temperature, undefined);
  }
  // Without an effort the API default (medium) applies, where Haiku 5.5 accepts thinking off.
  await probeModel(model, { anthropic: "sk-offline-test-key" }, AbortSignal.timeout(10_000), false);
  const probe = requests.at(-1)!;
  assert.deepEqual(probe.body.thinking, { type: "disabled" });
  assert.equal(probe.body.output_config, undefined);
  assert.equal(probe.body.speed, undefined);
  assert.ok(!probe.headers.get("anthropic-beta")?.includes("fast-mode-2026-02-01"));
});

function okStream(modelId: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function assertMandatoryThinkingWire(t: TestContext, modelId: string): Promise<void> {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return okStream(modelId);
  }) as typeof fetch;
  const model = { ...getRequiredModel(modelId, false), headers: { "anthropic-beta": "prior-beta" } };
  const runtime = await buildModelRuntime({ anthropic: "sk-offline-test-key" });
  for (const effort of [undefined, "low", "xhigh", "max"] as const) {
    const response = await runtime
      .streamSimple(model, context, {
        reasoning: effort,
        maxRetries: 0,
        onPayload: (payload) => ({ ...(payload as object), metadata: { user_id: "caller-hook" } }),
      })
      .result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    const request = requests.at(-1)!;
    assert.ok(request.headers.get("anthropic-beta")?.includes("prior-beta"));
    assert.ok(request.headers.get("anthropic-beta")?.includes(bindingBeta));
    assert.deepEqual(request.body.thinking, {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    assert.deepEqual(request.body.metadata, { user_id: "caller-hook" });
    if (effort) assert.deepEqual(request.body.output_config, { effort });
  }
  const streamed = await runtime.stream(model, context, { maxRetries: 0 }).result();
  assert.equal(streamed.stopReason, "stop", streamed.errorMessage);
  assert.deepEqual(requests.at(-1)!.body.thinking, {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  const fast = modelSupportsFastMode(modelId);
  await probeModel(model, { anthropic: "sk-offline-test-key" }, AbortSignal.timeout(10_000), fast);
  assert.equal(requests.at(-1)!.body.speed, fast ? "fast" : undefined);
  const betas = requests.at(-1)!.headers.get("anthropic-beta")!.split(",");
  assert.equal(betas.filter((beta) => beta === bindingBeta).length, 1);
  assert.equal(betas.includes("fast-mode-2026-02-01"), fast);
  assert.deepEqual(model.headers, { "anthropic-beta": "prior-beta" });

  const gateway = await buildModelRuntime(
    {},
    {
      url: "https://gateway.invalid",
      apiKey: "test-gateway-key",
      apiKeyHeader: "x-test-key",
      models: { [model.id]: "routed-opus" },
    },
  );
  await gateway.streamSimple(model, context, { reasoning: "low", maxRetries: 0 }).result();
  const routed = requests.at(-1)!;
  assert.equal(routed.body.model, "routed-opus");
  assert.equal(routed.headers.get("x-test-key"), "test-gateway-key");
  assert.ok(!routed.headers.get("anthropic-beta")?.includes(bindingBeta));
  assert.deepEqual(routed.body.thinking, { type: "adaptive", display: "summarized" });

  await runtime
    .streamSimple(getRequiredModel("claude-haiku-4-5", false), context, { reasoning: "low", maxRetries: 0 })
    .result();
  const haiku = requests.at(-1)!;
  assert.ok(!haiku.headers.get("anthropic-beta")?.includes(bindingBeta));
  assert.ok(haiku.headers.get("anthropic-beta")?.includes("interleaved-thinking"));
}
