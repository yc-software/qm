import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

interface Canvas {
  panes: () => number;
  tiles: () => number;
  newChat: () => boolean;
  seededChat: () => { state: { threadRef: string | null; agent: unknown } } | null;
  addTile: () => boolean;
}

async function withCanvas(run: (canvas: Canvas) => void | Promise<void>): Promise<void> {
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
    fetch: async () =>
      Response.json({
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: [] },
        modelCatalog: {},
        fastModeModelIds: [],
        interactiveFastMode: false,
        effective: { harnessId: "pi", modelId: "" },
        sessions: [],
        items: [],
      }),
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
    const { appState } = await vite.ssrLoadModule("/src/shell.ts");
    const split = await vite.ssrLoadModule("/src/split.ts");
    appState.me = { user: "tester", org: "test" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    document.body.append(appState.mainEl);
    assert.equal(split.mountRestoredCanvas(), true);
    await run({
      panes: () => document.querySelectorAll(".dv-tab").length,
      tiles: () => document.querySelectorAll(".dv-groupview").length,
      newChat: () => split.openBlankInFocusedPane(),
      seededChat: () => split.startNewChat(),
      addTile: () => split.addBlankPane(),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("New chat replaces one pane, then joins the arrangement the viewer built", async () => {
  await withCanvas((canvas) => {
    assert.deepEqual([canvas.panes(), canvas.tiles()], [1, 1]);

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [1, 1], "one session: New chat replaces it");

    canvas.addTile();
    assert.deepEqual([canvas.panes(), canvas.tiles()], [2, 2]);

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [3, 3], "split screen: New chat adds a window");

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [4, 4]);

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [5, 4], "at the window limit: New chat adds a tab");
  });
});

// The prompt- and draft-seeding entry points (chat search, the cron actions, deploy) need
// the conversation the canvas just placed — not the full-window one they used to claim.
test("a seeded New chat hands back the conversation in the pane it just placed", async () => {
  await withCanvas((canvas) => {
    const first = canvas.seededChat();
    assert.ok(first, "the canvas must return a live conversation to seed");
    assert.ok(first.state.threadRef, "…already mounted on its own new thread");
    assert.ok(first.state.agent, "…with an agent a caller can prompt");
    assert.deepEqual([canvas.panes(), canvas.tiles()], [1, 1], "one session: it replaces that pane");

    canvas.addTile();
    const second = canvas.seededChat();
    assert.ok(second);
    assert.notEqual(second.state.threadRef, first.state.threadRef, "each one is its own conversation");
    assert.deepEqual([canvas.panes(), canvas.tiles()], [3, 3], "split screen: it adds a window, same as the button");
  });
});
