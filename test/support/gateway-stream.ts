import type { TestContext } from "node:test";

export function anthropicStream(text: string): string {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_context",
        type: "message",
        role: "assistant",
        model: "router/haiku",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

export function recordRequests(t: TestContext, reply = "ok"): Array<{ url: string; headers: Headers; body: string }> {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(anthropicStream(reply), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return requests;
}

export const contextHeaders = (headers: Headers) =>
  Object.fromEntries([...headers].filter(([name]) => name.startsWith("x-qm-")));
