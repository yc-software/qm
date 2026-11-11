import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { webFetch } from "../src/core-bridge.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

function scriptedFetch(outcomes: Array<number | Error>): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = async () => {
    const next = outcomes[Math.min(calls++, outcomes.length - 1)]!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  };
  return { calls: () => calls };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout"] });
  let done = false;
  void promise.finally(() => (done = true)).catch(() => undefined);
  while (!done) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(500);
  }
  return promise;
}

test("webFetch retries an idempotent load through deploy-window 502 and 503 responses", async () => {
  const fetch = scriptedFetch([502, 503, 200]);
  const response = await settle(webFetch("/api/sessions"));
  assert.equal(response.status, 200);
  assert.equal(fetch.calls(), 3);
});

test("webFetch retries a network failure on a GET", async () => {
  const fetch = scriptedFetch([new TypeError("Failed to fetch"), 200]);
  const response = await settle(webFetch("/api/sessions"));
  assert.equal(response.status, 200);
  assert.equal(fetch.calls(), 2);
});

test("webFetch returns the last transient response after two retries", async () => {
  const fetch = scriptedFetch([502]);
  const response = await settle(webFetch("/api/sessions"));
  assert.equal(response.status, 502);
  assert.equal(fetch.calls(), 3);
});

test("webFetch never repeats a request with a body", async () => {
  const fetch = scriptedFetch([503, 200]);
  const response = await settle(webFetch("/api/turn", { method: "POST", body: "{}" }));
  assert.equal(response.status, 503);
  assert.equal(fetch.calls(), 1);
});

test("webFetch does not retry ordinary client errors", async () => {
  const fetch = scriptedFetch([404, 200]);
  const response = await settle(webFetch("/api/sessions"));
  assert.equal(response.status, 404);
  assert.equal(fetch.calls(), 1);
});
