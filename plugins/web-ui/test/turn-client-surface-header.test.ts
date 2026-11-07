import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { queueTurn } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;
const agent = { state: { model: MODEL, messages: [], isStreaming: false } } as unknown as Agent;

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

async function declaredSurface(): Promise<string | null> {
  let declared: string | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    declared = new Headers(init?.headers).get("x-qm-client");
    return { ok: true, status: 202, text: async () => JSON.stringify({ status: "queued", runId: "run-1" }) };
  }) as unknown as typeof fetch;
  await queueTurn("web:u:t", "hello", agent);
  return declared;
}

test("the browser declares itself as the client surface of a turn", async () => {
  assert.equal(await declaredSurface(), "browser");
});

test("the desktop app declares itself as the client surface of a turn", async () => {
  (globalThis as { window?: unknown }).window = { qmDesktop: { platform: "linux" } };
  assert.equal(await declaredSurface(), "desktop");
});
