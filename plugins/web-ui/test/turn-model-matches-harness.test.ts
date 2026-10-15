import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model, Api } from "@earendil-works/pi-ai";
import { queueTurn } from "../src/core-bridge.ts";

test("a queued turn sends the picked model with the picked harness, even if the agent still holds an older model", async () => {
  const stale = { id: "claude-opus-5", api: "anthropic-messages", provider: "anthropic" } as unknown as Model<Api>;
  const agent = new Agent({ initialState: { model: stale } });
  let body: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ runId: "r1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await queueTurn("web:t1", "hi", agent, () => ({ harness: "codex", model: "gpt-6-astra" }));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(body.harness, "codex");
  assert.equal(body.model, "gpt-6-astra");
});
