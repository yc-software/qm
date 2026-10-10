import assert from "node:assert/strict";
import { test } from "node:test";
import { appState } from "../src/shell-state.ts";
import { uiCanvasPanel } from "../src/ui-canvas.ts";

test("redraws during an in-flight canvas fetch do not restart it", async () => {
  let fetches = 0;
  let release = () => {};
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches++;
    await new Promise<void>((resolve) => (release = resolve));
    return new Response(JSON.stringify({ canvas: null }), { status: 200 });
  }) as typeof fetch;
  appState.me = { email: "a@example.com" } as unknown as typeof appState.me;
  let redraws = 0;
  const owner = { chat: { state: { sessionId: "s-livelock" }, redraw: () => redraws++ } } as unknown as Parameters<
    typeof uiCanvasPanel
  >[0];
  try {
    for (let i = 0; i < 5; i++) uiCanvasPanel(owner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    for (let i = 0; i < 20 && redraws === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fetches, 1);
    assert.equal(redraws, 1);
  } finally {
    globalThis.fetch = original;
    appState.me = null;
  }
});
