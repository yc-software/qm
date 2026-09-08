import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Conversation } from "../src/conv-types.ts";
import type { PendingApproval, SessionEntry } from "../src/core-bridge.ts";
import { metadata } from "./model-metadata.ts";

export function installDom(html = '<!doctype html><div id="app"></div>'): JSDOM {
  const dom = new JSDOM(html, { url: "http://localhost/" });
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
    CustomEvent: dom.window.CustomEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: undefined,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return dom;
}

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

export const session = { id: "s1", threadRef: "web:owner:test", scopeId: "personal:owner", title: "Test" };

function coreRoutes(entries: SessionEntry[], approvals: PendingApproval[]): typeof fetch {
  return async (input) => {
    const path = String(input);
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId: session.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["gpt-5.6-sol"] },
        modelCatalog: { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path.endsWith("/approvals")) return Response.json({ approvals });
    if (path.startsWith("/api/sessions/s1")) return Response.json({ session, entries, earlierEntries: 0 });
    if (path === "/api/sessions") return Response.json({ sessions: [session] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
}

export async function bootConversation({
  entries,
  approvals = [],
  fetch: route = coreRoutes(entries, approvals),
}: {
  entries: SessionEntry[];
  approvals?: PendingApproval[];
  fetch?: typeof fetch;
}) {
  const dom = installDom('<!doctype html><div id="app"></div><main id="main"></main>');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = route;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let conv: Conversation | undefined;
  const dispose = async (): Promise<void> => {
    conv?.state.agent?.abort();
    await conv?.state.agent?.waitForIdle();
    conv?.composer.dispose();
    conv?.dispose();
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  };
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { entriesToMessages, attachPendingApprovals } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/composer.ts");
    seedRuntimeConfig(session.scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = [session];
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    const chat = createConversation({
      pane: true,
      ownsUrl: false,
      container: () => host,
      claimContainer: () => host,
      visible: () => true,
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream() {},
    }) as Conversation;
    conv = chat;
    const mount = (pending: PendingApproval[] = approvals): void => {
      const messages = entriesToMessages(entries, transcriptModel());
      attachPendingApprovals(messages, pending, transcriptModel());
      chat.mountContinuable(session.threadRef, session.id, session.scopeId, messages);
    };
    return { conv: chat, host, mount, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
