import { metadata } from "./model-metadata.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Conversation } from "../src/conv-types.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("opening a session from the list shows and sends the runtime its last web turn used", async () => {
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

  const scopeId = "personal:owner";
  const rows = {
    sonnet: { id: "s-sonnet", threadRef: "web:owner:sonnet", scopeId, title: "On Sonnet" },
    fresh: { id: "s-fresh", threadRef: "web:owner:fresh", scopeId, title: "Never sent from web" },
    retired: { id: "s-retired", threadRef: "web:owner:retired", scopeId, title: "On a retired model" },
  };
  const runtimes: Record<string, unknown> = {
    "s-sonnet": { harnessId: "pi", modelId: "sonnet", effortLevel: "max", fastMode: false },
    "s-retired": { harnessId: "pi", modelId: "retired", effortLevel: "high" },
  };
  const turns: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["opus", "sonnet"] },
        modelCatalog: {
          opus: { ...metadata("opus", "Opus 5", "anthropic"), reasoning: true },
          sonnet: { ...metadata("sonnet", "Sonnet 5.5", "anthropic"), reasoning: true },
        },
        orgDefault: { harnessId: "pi", modelId: "opus", effortLevel: "low", revision: 0 },
        effective: { harnessId: "pi", modelId: "opus", effortLevel: "low" },
        scopeOverride: null,
      });
    const session = Object.values(rows).find((row) => path.startsWith(`/api/sessions/${row.id}`));
    if (session && path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (session) {
      const entries = [{ seq: 1, type: "user", createdAt: Date.now(), payload: { text: "hello" } }];
      return Response.json({ session, entries, ...(runtimes[session.id] ? { runtime: runtimes[session.id] } : {}) });
    }
    if (path === "/api/turn") {
      turns.push(JSON.parse(String(init?.body)));
      return Response.json({ runId: "r1" });
    }
    if (path === "/api/runs/r1") return Response.json({ status: "done", result: { status: "ok", reply: "done" } });
    if (path.startsWith("/api/ui-canvas/")) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path === "/api/sessions") return Response.json({ sessions: Object.values(rows) });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let conv: Conversation | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState, openSessionInto } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = Object.values(rows);
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
    const chat = conv;
    const picker = () => host.querySelector(".loadout-button")?.getAttribute("aria-label");

    await openSessionInto(chat, rows.sonnet, undefined, undefined, false);
    await until(() => picker() === "Model: Sonnet 5.5, Max effort");
    assert.equal(chat.state.threadRef, rows.sonnet.threadRef);

    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "keep going";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => turns.length === 1);
    assert.deepEqual(
      { harness: turns[0]!.harness, model: turns[0]!.model, thinkingLevel: turns[0]!.thinkingLevel },
      { harness: "pi", model: "sonnet", thinkingLevel: "max" },
    );

    await openSessionInto(chat, rows.fresh, undefined, undefined, false);
    await until(() => chat.state.threadRef === rows.fresh.threadRef && picker() === "Model: Opus 5, Low effort");

    await openSessionInto(chat, rows.retired, undefined, undefined, false);
    await until(() => chat.state.threadRef === rows.retired.threadRef && !!picker());
    assert.equal(picker(), "Model: Opus 5, Low effort", "a model the viewer cannot run is not adopted");
  } finally {
    conv?.dispose?.();
    await vite.close();
    globalThis.fetch = originalFetch;
  }
});
