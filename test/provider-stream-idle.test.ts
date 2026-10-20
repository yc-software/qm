import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { providerTurnError } from "../src/harness/provider-error.ts";

const IDLE_MS = 300;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const anthropicStart = sse("message_start", {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: "m",
    usage: { input_tokens: 5, output_tokens: 0 },
  },
});
const anthropicText = (text: string) =>
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const anthropicEnd = [
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
  sse("message_stop", { type: "message_stop" }),
];
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

interface Provider {
  name: string;
  run: (baseUrl: string, signal?: AbortSignal) => Promise<AssistantMessage>;
  path: string;
  first: string;
  text: (t: string) => string;
  end: string[];
}

const model = (api: string, baseUrl: string) =>
  ({
    id: "m",
    name: "m",
    api,
    provider: "gateway",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  }) as Model<never>;
const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

const PROVIDERS: Provider[] = [
  {
    name: "anthropic-messages",
    run: (baseUrl, signal) =>
      anthropicStream(model("anthropic-messages", baseUrl) as Model<"anthropic-messages">, context, {
        apiKey: "k",
        timeoutMs: IDLE_MS,
        signal,
      }).result(),
    path: "",
    first:
      anthropicStart +
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    text: anthropicText,
    end: anthropicEnd,
  },
  {
    name: "openai-completions",
    run: (baseUrl, signal) =>
      completionsStream(model("openai-completions", baseUrl) as Model<"openai-completions">, context, {
        apiKey: "k",
        timeoutMs: IDLE_MS,
        signal,
      }).result(),
    path: "/v1",
    first: chunk({ role: "assistant", content: "" }),
    text: (text) => chunk({ content: text }),
    end: [chunk({}, "stop"), "data: [DONE]\n\n"],
  },
];

async function serve(t: TestContext, respond: (res: ServerResponse) => void) {
  const closed: Array<() => void> = [];
  const requestClosed = new Promise<void>((resolve) => closed.push(resolve));
  const server = createServer((req, res) => {
    req.socket.on("close", () => closed.forEach((resolve) => resolve()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as { port: number }).port, requestClosed };
}

for (const p of PROVIDERS) {
  test(`${p.name}: a stream that stalls after its first event fails as a retryable idle timeout and closes the request`, async (t) => {
    const { port, requestClosed } = await serve(t, (res) => res.write(p.first));
    const started = Date.now();
    const failed = await p.run(`http://127.0.0.1:${port}${p.path}`);
    assert.ok(Date.now() - started < IDLE_MS * 10);
    assert.equal(failed.stopReason, "error");
    assert.deepEqual(failed.providerError, { type: "stream_idle_timeout" });
    const error = providerTurnError(failed);
    assert.equal(error.code, "transient");
    assert.equal(error.retryable, true);
    await requestClosed;
  });

  test(`${p.name}: slow chunks inside the idle bound complete, and the deadline is cleared after the reply`, async (t) => {
    const { port } = await serve(t, (res) => {
      res.write(p.first);
      const parts = ["one ", "two ", "three"];
      const timer = setInterval(() => {
        const next = parts.shift();
        if (next !== undefined) return void res.write(p.text(next));
        clearInterval(timer);
        for (const line of p.end) res.write(line);
        res.end();
      }, IDLE_MS / 2);
    });
    const done = await p.run(`http://127.0.0.1:${port}${p.path}`);
    assert.equal(done.stopReason, "stop");
    assert.deepEqual(
      done.content.map((block) => (block.type === "text" ? block.text : "")),
      ["one two three"],
    );
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    assert.equal(done.stopReason, "stop");
  });

  test(`${p.name}: a caller abort during a stalled stream ends the turn as aborted, not as an idle timeout`, async (t) => {
    const { port, requestClosed } = await serve(t, (res) => res.write(p.first));
    const caller = new AbortController();
    setTimeout(() => caller.abort(), IDLE_MS / 3);
    const aborted = await p.run(`http://127.0.0.1:${port}${p.path}`, caller.signal);
    assert.equal(aborted.stopReason, "aborted");
    assert.equal(aborted.providerError, undefined);
    await requestClosed;
  });
}

for (const p of PROVIDERS) {
  test(`${p.name}: SSE comment heartbeats and a slowly delivered event count as activity`, async (t) => {
    const { port } = await serve(t, (res) => {
      res.write(p.first);
      const event = p.text("after a long think");
      const writes = [
        ...Array.from({ length: 6 }, () => ": keepalive\n\n"),
        ...Array.from({ length: 6 }, (_, i) => event.slice((i * event.length) / 6, ((i + 1) * event.length) / 6)),
      ];
      const timer = setInterval(() => {
        const next = writes.shift();
        if (next !== undefined) return void res.write(next);
        clearInterval(timer);
        for (const line of p.end) res.write(line);
        res.end();
      }, IDLE_MS / 3);
    });
    const done = await p.run(`http://127.0.0.1:${port}${p.path}`);
    assert.equal(done.stopReason, "stop", done.errorMessage);
    assert.deepEqual(
      done.content.map((block) => (block.type === "text" ? block.text : "")),
      ["after a long think"],
    );
  });
}

test("anthropic-messages: ping events during a long silence keep the stream alive", async (t) => {
  const anthropic = PROVIDERS[0]!;
  const { port } = await serve(t, (res) => {
    res.write(anthropic.first);
    let pings = 0;
    const timer = setInterval(() => {
      if (++pings <= 6) return void res.write(sse("ping", { type: "ping" }));
      clearInterval(timer);
      res.write(anthropic.text("after thinking"));
      for (const line of anthropic.end) res.write(line);
      res.end();
    }, IDLE_MS / 2);
  });
  const done = await anthropic.run(`http://127.0.0.1:${port}`);
  assert.equal(done.stopReason, "stop");
  assert.deepEqual(
    done.content.map((block) => (block.type === "text" ? block.text : "")),
    ["after thinking"],
  );
});
