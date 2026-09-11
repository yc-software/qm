import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

interface Canvas {
  panes: () => number;
  tiles: () => number;
  newChat: () => boolean;
  tabCounts: () => number[];
  focusTile: (index: number) => void;
  splitTile: (index: number) => void;
  seededChat: (threadRef?: string) => { state: { threadRef: string | null; agent: unknown } } | null;
  split: () => void;
  switchAway: () => void;
}

async function withCanvas(run: (canvas: Canvas) => void | Promise<void>, stacked = false): Promise<void> {
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
    const sessions = await vite.ssrLoadModule("/src/sessions.ts");
    appState.me = { user: "tester", org: "test" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    document.body.append(appState.mainEl);
    assert.ok(sessions.startNewChat());
    if (stacked) {
      localStorage.setItem(
        "web-ui:split-canvas:v1",
        JSON.stringify({
          v: 2,
          active: true,
          layout: {
            grid: {
              root: {
                type: "branch",
                data: [
                  {
                    type: "leaf",
                    data: {
                      views: ["a", "b"],
                      activeView: "a",
                      id: "stack",
                    },
                  },
                ],
              },
              width: 1000,
              height: 800,
              orientation: "HORIZONTAL",
            },
            panels: Object.fromEntries(
              ["a", "b"].map((id) => [
                id,
                {
                  id,
                  contentComponent: "pane",
                  tabComponent: "pane",
                  params: {},
                  title: "New session",
                },
              ]),
            ),
            activeGroup: "stack",
          },
        }),
      );
      split.loadPersistedSplit();
      assert.equal(split.mountRestoredCanvas(), true);
    }
    await run({
      panes: () => document.querySelectorAll(".dv-tab").length,
      tabCounts: () =>
        Array.from(document.querySelectorAll(".dv-groupview"), (g) => g.querySelectorAll(".dv-tab").length),
      focusTile: (index) => {
        document
          .querySelectorAll(".dv-groupview")
          .item(index)!
          .querySelector(".dv-tab")!
          .dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
      },
      splitTile: (index) => {
        document
          .querySelectorAll(".dv-groupview")
          .item(index)!
          .querySelector<HTMLButtonElement>('[aria-label="Split this pane with a new session"]')!
          .click();
      },
      tiles: () => document.querySelectorAll(".dv-groupview").length,
      newChat: () => sessions.startNewChat() !== null,
      seededChat: (threadRef) => sessions.startNewChat(null, null, threadRef),
      split: () => split.activateCanvas({}, {}, "right"),
      switchAway: () => {
        appState.currentView = "crons";
        appState.mainEl.replaceChildren();
      },
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

test("New chat stops splitting after three tiles and adds tabs to the selected pane", async () => {
  await withCanvas((canvas) => {
    assert.deepEqual([canvas.panes(), canvas.tiles()], [0, 0]);

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [0, 0], "one session: New chat replaces it");

    canvas.split();
    assert.deepEqual([canvas.panes(), canvas.tiles()], [2, 2]);

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [3, 3], "split screen: New chat adds a window");

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [4, 3], "three tiles: New chat adds a tab");

    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [5, 3], "further sessions also add tabs");
    assert.deepEqual(canvas.tabCounts(), [1, 1, 3]);
    canvas.focusTile(0);
    assert.equal(canvas.newChat(), true);
    assert.deepEqual(canvas.tabCounts(), [2, 1, 3], "the new tab follows the selected pane");
    canvas.splitTile(2);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [7, 4], "explicit splitting still creates a fourth tile");
    assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [8, 4], "four tiles: New chat still adds a tab");
  });
});

test("a seeded New chat hands back the conversation in the pane it just placed", async () => {
  await withCanvas((canvas) => {
    const first = canvas.seededChat();
    assert.ok(first, "the canvas must return a live conversation to seed");
    assert.ok(first.state.threadRef, "…already mounted on its own new thread");
    assert.ok(first.state.agent, "…with an agent a caller can prompt");
    assert.deepEqual([canvas.panes(), canvas.tiles()], [0, 0], "one session: it replaces that pane");

    canvas.split();
    const second = canvas.seededChat();
    assert.ok(second);
    assert.notEqual(second.state.threadRef, first.state.threadRef, "each one is its own conversation");
    assert.deepEqual([canvas.panes(), canvas.tiles()], [3, 3], "split screen: it adds a window, same as the button");
  });
});

test("seeded chats return from another view without losing the grid or supplied thread", async () => {
  await withCanvas((canvas) => {
    canvas.split();
    canvas.switchAway();
    const thread = "web:tester:app-edit:example";
    const conv = canvas.seededChat(thread);
    assert.ok(conv?.state.agent);
    assert.equal(conv?.state.threadRef, thread);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [3, 3]);
  });
});

test("new chat replaces the focused conversation at capacity without dropping the grid", async () => {
  await withCanvas((canvas) => {
    canvas.split();
    for (let i = 2; i < 12; i++) assert.equal(canvas.newChat(), true);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [12, 3]);
    assert.ok(canvas.seededChat()?.state.agent);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [12, 3]);
  });
});

test("a restored tab-only arrangement gains a tab, not a tile", async () => {
  await withCanvas((canvas) => {
    assert.deepEqual([canvas.panes(), canvas.tiles()], [2, 1]);
    assert.ok(canvas.seededChat()?.state.agent);
    assert.deepEqual([canvas.panes(), canvas.tiles()], [3, 1]);
  }, true);
});
