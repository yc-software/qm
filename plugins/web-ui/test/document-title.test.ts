import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { activeSessionForDocumentTitle, documentTitle, PRODUCT_TITLE } from "../src/document-title.ts";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("page titles retain the static product title", () => {
  assert.ok(index.includes(`<title>${PRODUCT_TITLE}</title>`));
  assert.equal(documentTitle("chats", "Quarterly planning", true), `Quarterly planning · ${PRODUCT_TITLE}`);
  assert.equal(documentTitle(), PRODUCT_TITLE);
});

test("chat and non-chat views have useful fallbacks", () => {
  assert.equal(documentTitle("chats"), `Chats · ${PRODUCT_TITLE}`);
  assert.equal(documentTitle("chats", null, true), `New chat · ${PRODUCT_TITLE}`);
  assert.equal(documentTitle("contexts"), `Projects · ${PRODUCT_TITLE}`);
  assert.equal(documentTitle("files"), `Files · ${PRODUCT_TITLE}`);
  assert.equal(documentTitle("keychain"), `Keychain · ${PRODUCT_TITLE}`);
});

test("active session selection follows conversation switches and title updates", () => {
  const sessions = [
    { id: "old", threadRef: "old-thread", title: "Old title" },
    { id: "new", threadRef: "new-thread", title: "New title" },
  ];
  const current: { openingKey: string | null; sessionId: string | null; threadRef: string | null } = {
    openingKey: null,
    sessionId: "old",
    threadRef: "old-thread",
  };

  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "Old title");
  current.openingKey = "new";
  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "New title");
  sessions[1].title = "Server-generated title";
  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "Server-generated title");
  current.openingKey = null;
  current.sessionId = "new";
  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "Server-generated title");
});

test("document title follows session switches, split-pane focus, and sign-out", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: globalThis.fetch,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState, signOut, syncDocumentTitle } = await vite.ssrLoadModule("/src/shell.ts");
    const { mainConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { openBackgroundInCanvas, splitInterceptsOpen } = await vite.ssrLoadModule("/src/split.ts");
    const oldSession = { id: "old", threadRef: "web:old", scopeId: "personal:tester", title: "Old title" };
    const newSession = { id: "new", threadRef: "web:new", scopeId: "personal:tester", title: "New title" };
    sessionsState.list = [oldSession, newSession];
    appState.me = { user: "tester", org: "test" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    document.body.append(appState.mainEl);
    mainConversation().state.sessionId = "old";
    mainConversation().state.threadRef = "web:old";
    syncDocumentTitle();
    assert.equal(document.title, `Old title · ${PRODUCT_TITLE}`);
    mainConversation().state.sessionId = "new";
    mainConversation().state.threadRef = "web:new";
    syncDocumentTitle();
    assert.equal(document.title, `New title · ${PRODUCT_TITLE}`);

    assert.equal(openBackgroundInCanvas(oldSession), true);
    assert.equal(splitInterceptsOpen(newSession), true);
    assert.equal(document.title, `New title · ${PRODUCT_TITLE}`);
    assert.equal(splitInterceptsOpen(oldSession), true);
    assert.equal(document.title, `Old title · ${PRODUCT_TITLE}`);

    globalThis.fetch = async () => new Response(null, { status: 204 });
    await signOut();
    assert.equal(document.title, PRODUCT_TITLE);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
