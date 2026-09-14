import { test } from "node:test";
import assert from "node:assert/strict";
import { beginSendTiming } from "../src/send-timing.ts";

test("browser traces are per attempt and render logging waits for a connected visible card", async () => {
  const originalFetch = globalThis.fetch;
  const originalFrame = globalThis.requestAnimationFrame;
  const originalLog = console.info;
  const events: Array<{ traceId: string; stage: string }> = [];
  const frames: FrameRequestCallback[] = [];
  globalThis.fetch = (async (_url, init) => {
    events.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  console.info = () => {};
  try {
    const first = beginSendTiming("/api/send-timing");
    const retry = beginSendTiming("/api/send-timing");
    assert.notEqual(first.traceId, retry.traceId);
    first.mark("request_start");
    first.mark("request_start");
    const card = { isConnected: false, getClientRects: () => [1] };
    first.onRendered(card as unknown as Element);
    frames.shift()!(0);
    assert.ok(!events.some((e) => e.stage === "queue_rendered"));
    card.isConnected = true;
    first.onRendered(card as unknown as Element);
    frames.shift()!(0);
    first.onRendered(card as unknown as Element);
    assert.equal(frames.length, 0);
    assert.equal(events.filter((e) => e.stage === "queue_rendered").length, 1);
    assert.equal(events.filter((e) => e.stage === "request_start").length, 1);
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    assert.doesNotThrow(() => retry.mark("error"));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalFrame;
    console.info = originalLog;
  }
});
