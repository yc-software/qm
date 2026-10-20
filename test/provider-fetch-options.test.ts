import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { stream as anthropicStream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";

// The vendored pi-ai passes StreamOptions.fetchOptions into each SDK request's fetch init. The same three
// adapters wrap the SDK fetch with idleTimeoutFetch, so these run with timeoutMs set to prove the wrapper
// forwards the init rather than dropping it.

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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
const options: StreamOptions = { apiKey: "k", timeoutMs: 5_000, maxRetries: 0, fetchOptions: { redirect: "error" } };

const RUNS = [
  {
    name: "anthropic-messages",
    path: "",
    run: (url: string) => anthropicStream(model("anthropic-messages", url), context, options),
  },
  {
    name: "openai-completions",
    path: "/v1",
    run: (url: string) => completionsStream(model("openai-completions", url), context, options),
  },
  {
    name: "openai-responses",
    path: "/v1",
    run: (url: string) => responsesStream(model("openai-responses", url), context, options),
  },
  {
    name: "streamSimple (anthropic-messages)",
    path: "",
    run: (url: string) => streamSimple(model("anthropic-messages", url), context, options),
  },
];

for (const r of RUNS) {
  test(`${r.name}: fetchOptions { redirect: "error" } refuses a cross-origin redirect with the idle timeout on`, async (t) => {
    const followed: string[] = [];
    const elsewhere = await listen(t, (req, res) => {
      followed.push(req.url!);
      res.end();
    });
    let asked = 0;
    const url = await listen(t, (req, res) => {
      asked++;
      res.writeHead(307, { location: `${elsewhere}${req.url}` });
      res.end();
    });
    const reply = await r.run(`${url}${r.path}`).result();
    assert.equal(reply.stopReason, "error");
    assert.equal(asked, 1);
    assert.deepEqual(followed, []);
  });
}
