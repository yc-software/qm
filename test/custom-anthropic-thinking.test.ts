import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const DROP_BLOCK = { prefix_mismatch_behavior: "drop_block" };

afterEach(() => setCustomProviders([]));

type Seen = { headers: IncomingHttpHeaders; body: Record<string, unknown> };

async function fakeAnthropic(): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const event = (name: string, data: object) =>
        `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        event("message_start", {
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "m",
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
      );
      res.write(event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      res.write(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }));
      res.write(event("content_block_stop", { index: 0 }));
      res.write(event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }));
      res.write(event("message_stop", {}));
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => server.close(),
  };
}

function register(baseUrl: string, models: Array<{ id: string; reasoning?: boolean }>, protocol = "anthropic"): void {
  setCustomProviders([
    { id: "direct", name: "Direct", protocol: protocol as "anthropic", baseUrl, models: models.map((m) => ({ ...m })) },
  ]);
}

function replayContext(model: Model<Api>, firstPrompt: string): Context {
  const prior: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "working it out", thinkingSignature: "signed-block" },
      { type: "text", text: "391" },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return {
    systemPrompt: "terse",
    messages: [
      { role: "user", content: firstPrompt, timestamp: Date.now() },
      prior,
      { role: "user", content: "add 9", timestamp: Date.now() },
    ],
  };
}

async function send(model: Model<Api>, reasoning?: "high"): Promise<void> {
  const runtime = await buildModelRuntime({ direct: "sk-direct" });
  const reply = await runtime
    .streamSimple(model, replayContext(model, "rewritten context: what is 17*23?"), reasoning ? { reasoning } : {})
    .result();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
}

test("a custom anthropic model of a known adaptive model sends thinking binding even with reasoning off", async () => {
  const upstream = await fakeAnthropic();
  try {
    register(upstream.url, [{ id: "claude-opus-5-5" }]);
    const model = resolveModel("custom/direct/claude-opus-5-5") as Model<Api>;
    await send(model);
    const [call] = upstream.seen;
    assert.ok(call);
    assert.equal(call.body.model, "claude-opus-5-5");
    assert.ok(String(call.headers["anthropic-beta"]).split(",").includes(BINDING_BETA));
    assert.deepEqual(call.body.thinking, { type: "adaptive", display: "summarized", block_binding: DROP_BLOCK });
    const replayed = (call.body.messages as Array<{ content: unknown }>)[1]!.content as Array<{ type: string }>;
    assert.equal(replayed[0]!.type, "thinking");
  } finally {
    upstream.close();
  }
});

test("reasoning on a custom anthropic model of a known adaptive model uses adaptive thinking with binding", async () => {
  const upstream = await fakeAnthropic();
  try {
    register(upstream.url, [{ id: "claude-opus-5-5", reasoning: true }]);
    await send(resolveModel("custom/direct/claude-opus-5-5") as Model<Api>, "high");
    const thinking = upstream.seen[0]!.body.thinking as Record<string, unknown>;
    assert.equal(thinking.type, "adaptive");
    assert.deepEqual(thinking.block_binding, DROP_BLOCK);
    assert.equal(thinking.budget_tokens, undefined);
  } finally {
    upstream.close();
  }
});

test("a custom anthropic model with an unrecognized id keeps the plain request", async () => {
  const upstream = await fakeAnthropic();
  try {
    register(upstream.url, [{ id: "compat-large" }]);
    await send(resolveModel("custom/direct/compat-large") as Model<Api>);
    const [call] = upstream.seen;
    assert.equal(call!.headers["anthropic-beta"]?.includes(BINDING_BETA) ?? false, false);
    assert.equal(call!.body.thinking, undefined);
  } finally {
    upstream.close();
  }
});

test("only anthropic-protocol custom models take on a known model's thinking traits", () => {
  register("https://llm.example.test/v1", [{ id: "claude-opus-5-5" }], "openai");
  const model = resolveModel("custom/direct/claude-opus-5-5");
  assert.equal(model?.api, "openai-completions");
  assert.equal(model?.compat, undefined);
  assert.equal(model?.thinkingLevelMap, undefined);
});

test("a custom model whose provider is gone fails as unavailable instead of sending its id upstream", async () => {
  const upstream = await fakeAnthropic();
  try {
    register(upstream.url, [{ id: "claude-opus-5-5" }]);
    const model = resolveModel("custom/direct/claude-opus-5-5") as Model<Api>;
    const runtime = await buildModelRuntime({ direct: "sk-direct" });
    setCustomProviders([]);
    const reply = await runtime.streamSimple(model, replayContext(model, "hi"), {}).result();
    assert.equal(reply.stopReason, "error");
    assert.match(String(reply.errorMessage), /Model is unavailable: custom\/direct\/claude-opus-5-5/);
    assert.equal((reply as { providerError?: { type?: string } }).providerError?.type, "model_unavailable");
    assert.equal(upstream.seen.length, 0);
  } finally {
    upstream.close();
  }
});
