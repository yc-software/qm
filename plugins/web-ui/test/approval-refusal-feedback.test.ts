import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { queueApprovalTurn } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;
const agent = {
  state: { model: MODEL, messages: [{ role: "user", content: "resolve conflicts" }], isStreaming: false },
} as unknown as Agent;
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

test("an approval returns its continuation run without polling it", async () => {
  let body: { approval?: unknown } = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ runId: "r-1" }) } as Response;
  }) as typeof fetch;

  assert.deepEqual(await queueApprovalTurn("web:u:t", agent, { requestId: "a-1", approved: true, scope: "once" }), {
    runId: "r-1",
    text: "resolve conflicts",
  });
  assert.deepEqual(body.approval, { requestId: "a-1", approved: true, scope: "once" });
});
