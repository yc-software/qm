import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createGatewayCatalog } from "../src/model/gateway-catalog.ts";
import { setGatewayModels } from "../src/model/gateway-models.ts";
import { fastModeModelIds, modelSupportsFastMode, resolveModel } from "../src/model/pi-models.ts";
import { piUsageToCallUsage } from "../src/model/model-runtime.ts";
import { servedFast, speedSniffingFetch, stampServedSpeed, type ServedSpeed } from "../src/model/served-speed.ts";

afterEach(() => setGatewayModels([]));

const group = (id: string, extra: object) => ({
  model_group: id,
  mode: "chat",
  supports_function_calling: true,
  max_input_tokens: 200000,
  max_output_tokens: 32000,
  input_cost_per_token: 0.000005,
  output_cost_per_token: 0.000025,
  providers: ["anthropic"],
  ...extra,
});

async function discover(models: object[]): Promise<void> {
  const fetcher: typeof fetch = async (url) =>
    Response.json({
      data: String(url).endsWith("/models")
        ? models.map((m) => ({ id: (m as { model_group: string }).model_group }))
        : models,
    });
  const { refresh } = createGatewayCatalog(
    { url: "https://gateway.example/v1", apiKey: "k", apiKeyHeader: "x-key", models: {} },
    fetcher,
  );
  await refresh();
}

test("gateway models the gateway flags for fast mode get the Fast toggle; others do not", async () => {
  await discover([
    group("claude-fable-5-2", { supports_fast_mode: true }),
    group("claude-plain", {}),
    group("openai-fast", { supports_fast_mode: true, providers: ["openai"] }),
  ]);
  assert.equal(modelSupportsFastMode("gateway/claude-fable-5-2"), true);
  assert.equal(modelSupportsFastMode("gateway/claude-plain"), false);
  assert.equal(modelSupportsFastMode("gateway/openai-fast"), false);
  assert.ok(fastModeModelIds().includes("gateway/claude-fable-5-2"));
  assert.ok(!fastModeModelIds().includes("gateway/claude-plain"));
});

function sse(speed: string | undefined): Response {
  const usage = speed ? `{"input_tokens":3,"output_tokens":1,"speed":"${speed}"}` : `{"input_tokens":3}`;
  const text = `event: message_start\ndata: {"type":"message_start","message":{"usage":${usage}}}\n\n`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("the served speed is read from the response stream without altering it", async () => {
  for (const speed of ["fast", "standard", undefined]) {
    const served: ServedSpeed = {};
    const response = await speedSniffingFetch(async () => sse(speed), served)("https://x");
    assert.equal(await response.text(), await sse(speed).text());
    assert.equal(served.speed, speed);
  }
});

test("model text that mentions speed cannot fake a fast response", async () => {
  const served: ServedSpeed = {};
  const body = `data: {"delta":{"text":"{\\"speed\\":\\"fast\\"}"}}\n\n`;
  await (await speedSniffingFetch(async () => new Response(body), served)("https://x")).text();
  assert.equal(served.speed, undefined);
});

test("the final message carries the served speed, defaulting to standard", async () => {
  for (const [speed, expected] of [
    ["fast", "fast"],
    [undefined, "standard"],
  ] as const) {
    const stream = stampServedSpeed(createAssistantMessageEventStream(), { speed });
    const message = { role: "assistant", content: [] } as unknown as AssistantMessage;
    stream.push({ type: "done", reason: "stop", message });
    const result = (await stream.result()) as AssistantMessage & { servedSpeed?: string };
    assert.equal(result.servedSpeed, expected);
  }
});

test("a gateway call is priced at the fast rate only when it was served fast", async () => {
  await discover([group("claude-fable-5-2", { supports_fast_mode: true })]);
  const model = resolveModel("gateway/claude-fable-5-2");
  assert.ok(model);
  const usage = {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1_000_000,
    cost: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
  };
  const cost = (speed: string | undefined, requested: boolean) =>
    piUsageToCallUsage(usage, model, servedFast(requested, speed), undefined)?.costUsd;
  assert.equal(cost("fast", true), 10);
  assert.equal(cost("standard", true), 5);
  assert.equal(servedFast(true, undefined), true);
  assert.equal(servedFast(false, undefined), false);
});
