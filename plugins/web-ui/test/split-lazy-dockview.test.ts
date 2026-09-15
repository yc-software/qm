import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

interface MediaState {
  matches: boolean;
  listeners: Array<(event: { matches: boolean }) => void>;
}

async function harness(phone: boolean) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/" });
  const media: MediaState = { matches: phone, listeners: [] };
  const realSetTimeout = globalThis.setTimeout;
  const globals = {
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/runtime-config")) {
        return Response.json({
          scopeId: "personal:tester",
          approvedHarnesses: [],
          modelsByHarness: {},
          modelCatalog: {},
          orgDefault: { harnessId: "pi", modelId: "m", revision: 1 },
          scopeOverride: null,
          effective: { harnessId: "pi", modelId: "m" },
          upgradeAvailable: false,
        });
      }
      if (url === "/api/sessions") return Response.json({ sessions: [] });
      if (url === "/api/contexts") return Response.json({ contexts: [] });
      return Response.json({ items: [] });
    },
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
    CustomEvent: dom.window.CustomEvent,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    cancelAnimationFrame: clearTimeout,
    EventSource: undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      realSetTimeout(() => callback(Date.now()), 0) as unknown as number,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: (query: string) => {
      const state = query.includes("max-width") ? media : { matches: false, listeners: [] };
      return {
        get matches() {
          return state.matches;
        },
        addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
          state.listeners.push(listener);
        },
        removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
          const index = state.listeners.indexOf(listener);
          if (index >= 0) state.listeners.splice(index, 1);
        },
      };
    },
  });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  const shell = await vite.ssrLoadModule("/src/shell.ts");
  const split = await vite.ssrLoadModule("/src/split.ts");
  shell.appState.me = { user: "tester", org: "test" };
  shell.appState.currentView = "chats";
  shell.appState.mainEl = dom.window.document.createElement("main");
  shell.appState.listEl = dom.window.document.createElement("aside");
  dom.window.document.body.append(shell.appState.listEl, shell.appState.mainEl);
  return {
    dom,
    media,
    shell,
    split,
    changePhone(matches: boolean) {
      media.matches = matches;
      for (const listener of media.listeners) listener({ matches });
    },
    async close() {
      await vite.close();
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition did not settle");
}

const savedCanvas = JSON.stringify({
  v: 2,
  active: true,
  layout: {
    grid: {
      root: {
        type: "branch",
        data: [{ type: "leaf", data: { views: ["a"], activeView: "a", id: "stack" } }],
      },
      width: 1000,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: {
      a: { id: "a", contentComponent: "pane", tabComponent: "pane", params: {}, title: "New session" },
    },
    activeGroup: "stack",
  },
});

test("phone startup skips Dockview while desktop preparation preserves synchronous mounts", async () => {
  const h = await harness(true);
  try {
    assert.equal(await h.split.prepareCanvas(), false);
    h.media.matches = false;
    assert.equal(h.split.mountRestoredCanvas(), false);
    assert.equal(await h.split.prepareCanvas(), true);
    assert.equal(h.split.mountRestoredCanvas(), true);
    assert.ok(h.dom.window.document.querySelector(".split-canvas"));
  } finally {
    await h.close();
  }
});

test("phone-to-desktop restoration waits for Dockview and rechecks the active view", async () => {
  const h = await harness(true);
  try {
    h.dom.window.localStorage.setItem("web-ui:split-canvas:v1", savedCanvas);
    h.split.loadPersistedSplit();
    h.shell.appState.currentView = "settings";
    h.changePhone(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.dom.window.document.querySelector(".split-canvas"), null);

    h.changePhone(true);
    h.shell.appState.currentView = "chats";
    h.changePhone(false);
    await eventually(() => h.dom.window.document.querySelector(".split-canvas") !== null);
    assert.equal(h.split.splitState.active, true);
    h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" }));

    h.changePhone(true);
    assert.equal(h.split.splitState.active, false);
    assert.equal(h.dom.window.document.querySelector(".split-canvas"), null);
  } finally {
    await h.close();
  }
});

test("the pre-shell barrier recovers when a phone boot becomes desktop before identity", async () => {
  const h = await harness(true);
  try {
    h.dom.window.localStorage.setItem("web-ui:split-canvas:v1", savedCanvas);
    h.shell.appState.me = null;
    assert.equal(await h.split.prepareCanvas(), false);
    h.changePhone(false);
    assert.equal(h.split.mountRestoredCanvas(), false);

    h.shell.appState.me = { user: "tester", org: "test" };
    assert.equal(await h.split.prepareCanvas(), true);
    h.split.loadPersistedSplit();
    assert.equal(h.split.mountRestoredCanvas(true), true);
    assert.ok(h.dom.window.document.querySelector(".split-canvas"));
  } finally {
    await h.close();
  }
});

test("phone-to-desktop preparation retries once and restores without another resize", async () => {
  const h = await harness(true);
  try {
    h.dom.window.localStorage.setItem("web-ui:split-canvas:v1", savedCanvas);
    h.split.loadPersistedSplit();
    const load = h.split.dockviewFactory.load.bind(h.split.dockviewFactory);
    let attempts = 0;
    h.split.dockviewFactory.load = () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("chunk unavailable")) : load();
    };

    h.changePhone(false);
    await eventually(() => h.dom.window.document.querySelector(".split-canvas") !== null);

    assert.equal(attempts, 2);
    assert.equal(h.split.splitState.active, true);
  } finally {
    await h.close();
  }
});

test("a stale desktop preparation cannot mount after media, identity, or view changes", async () => {
  for (const stale of ["media", "identity", "view"] as const) {
    const h = await harness(true);
    let release = (): void => {};
    try {
      h.dom.window.localStorage.setItem("web-ui:split-canvas:v1", savedCanvas);
      h.split.loadPersistedSplit();
      const load = h.split.dockviewFactory.load.bind(h.split.dockviewFactory);
      let attempts = 0;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      h.split.dockviewFactory.load = async () => {
        attempts++;
        await blocked;
        return load();
      };

      h.changePhone(false);
      await eventually(() => attempts === 1);
      if (stale === "media") h.changePhone(true);
      else if (stale === "identity") h.shell.appState.me = { user: "replacement", org: "test" };
      else h.shell.switchView("settings");
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(h.dom.window.document.querySelector(".split-canvas"), null, stale);
      assert.equal(attempts, 1, stale);
    } finally {
      release();
      await h.close();
    }
  }
});
