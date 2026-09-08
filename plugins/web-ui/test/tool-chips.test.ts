import { metadata } from "./model-metadata.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Conversation } from "../src/conv-types.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("tool rows render their label beside a mono detail chip, tinted by outcome", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', { url: "http://localhost/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: undefined,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const row = { id: "s1", threadRef: "web:owner:test", scopeId: "personal:owner", title: "Test" };
  const entries = [
    { seq: 1, type: "user", createdAt: 1, payload: { text: "ship it" } },
    { seq: 2, parentSeq: 1, type: "tool_call", createdAt: 2, payload: { tool: "execute", command: "npm run freeze" } },
    { seq: 3, parentSeq: 2, type: "tool_result", createdAt: 3, payload: { tool: "execute", code: 0, stdout: "ok" } },
    { seq: 4, parentSeq: 1, type: "tool_call", createdAt: 4, payload: { tool: "write", path: "ChurnSchedule.tsx" } },
    { seq: 5, parentSeq: 4, type: "tool_result", createdAt: 5, payload: { tool: "write", error: "read-only" } },
    { seq: 6, parentSeq: 1, type: "tool_call", createdAt: 6, payload: { tool: "recall" } },
    { seq: 7, parentSeq: 6, type: "tool_result", createdAt: 7, payload: { tool: "recall" } },
    { seq: 8, type: "assistant", createdAt: 8, payload: { text: "done" } },
  ];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId: row.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["gpt-5.6-sol"] },
        modelCatalog: { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.startsWith("/api/sessions/s1")) return Response.json({ session: row, entries, earlierEntries: 0 });
    if (path === "/api/sessions") return Response.json({ sessions: [row] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let conv: Conversation | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { entriesToMessages } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/composer.ts");
    seedRuntimeConfig(row.scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = [row];
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    conv = createConversation({
      pane: true,
      ownsUrl: false,
      container: () => host,
      claimContainer: () => host,
      visible: () => true,
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream() {},
    }) as Conversation;
    conv.mountContinuable(row.threadRef, row.id, row.scopeId, entriesToMessages(entries, transcriptModel()));
    await until(() => host.querySelectorAll(".tool-row").length === 3);

    const ok = host.querySelector(".tool-row.tool-ok")!;
    assert.equal(ok.querySelector(".tool-name")?.textContent, "Ran command");
    const chip = ok.querySelector(".tool-label.tool-chip")!;
    assert.equal(chip.textContent, "npm run freeze");
    assert.equal(chip.getAttribute("title"), "Ran command: npm run freeze");
    assert.ok(ok.querySelector(".tool-icon svg"), "settled rows keep their tool glyph");

    const failed = host.querySelector(".tool-row.tool-failed")!;
    assert.equal(failed.querySelector(".tool-name")?.textContent, "Tried writing file");
    assert.equal(failed.querySelector(".tool-chip")?.textContent, "ChurnSchedule.tsx · read-only");

    const bare = host.querySelector(".tool-row.tool-ok:has(.tool-label:not(.tool-chip))")!;
    assert.equal(bare.querySelector(".tool-name"), null, "a row without detail shows only its label");
    assert.equal(bare.querySelector(".tool-label")?.textContent, "Searched memory");
  } finally {
    conv?.dispose();
    await vite.close();
  }
});
