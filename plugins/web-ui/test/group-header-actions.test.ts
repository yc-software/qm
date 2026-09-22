import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

async function withTabs(run: (requests: string[]) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/" });
  const requests: string[] = [];
  const list = ["a", "b", "c"].map((id) => ({
    id,
    title: id,
    type: "dm",
    scopeId: "personal:tester",
    threadRef: `web:tester:${id}`,
    createdAt: 1,
  }));
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
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push(`${init?.method ?? "GET"} ${path.split("?")[0]}`);
      if (path.includes("/share")) return Response.json({ share: null });
      const session = list.find((s) => path.split("?")[0] === `/api/sessions/${s.id}`);
      return Response.json({
        session,
        sessions: list,
        entries: [],
        approvals: [],
        items: [],
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "" },
      });
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let split: { exitSplitIfActive(): void } | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell.ts");
    const canvas = await vite.ssrLoadModule("/src/split.ts");
    split = canvas as typeof split;
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    appState.me = { user: "tester", org: "test" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    document.body.append(appState.mainEl);
    sessionsState.list = list;
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
                { type: "leaf", data: { views: ["a", "b"], activeView: "b", id: "stack" } },
                { type: "leaf", data: { views: ["c"], activeView: "c", id: "other" } },
              ],
            },
            width: 1000,
            height: 800,
            orientation: "HORIZONTAL",
          },
          panels: Object.fromEntries(
            list.map((s) => [
              s.id,
              {
                id: s.id,
                contentComponent: "pane",
                tabComponent: "pane",
                params: { sessionId: s.id, threadRef: s.threadRef },
                title: s.title,
              },
            ]),
          ),
          activeGroup: "stack",
        },
      }),
    );
    canvas.loadPersistedSplit();
    assert.equal(canvas.mountRestoredCanvas(), true);
    // Warm both tabs so switching does not trigger a transcript load and incidental redraw.
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const title of ["a", "b"]) {
      const tab = Array.from(document.querySelectorAll(".dv-tab")).find(
        (el) => el.querySelector(".split-pane-title-text")?.textContent?.trim() === title,
      )!;
      tab.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    requests.length = 0;
    await run(requests);
  } finally {
    split?.exitSplitIfActive();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

for (const action of ["Archive session", "Share conversation"]) {
  test(`group ${action} follows the surviving tab after closing the active tab`, async () => {
    await withTabs(async (requests) => {
      const tabs = Array.from(document.querySelectorAll(".dv-tab"));
      const closed = tabs.find((el) => el.querySelector(".split-pane-title-text")?.textContent?.trim() === "b")!;
      const group = closed.closest(".dv-groupview")!;
      closed.querySelector<HTMLButtonElement>('[aria-label="Close pane"]')!.click();
      assert.equal(group.querySelectorAll(".dv-tab").length, 1);
      assert.equal(group.querySelector(".split-pane-title-text")?.textContent?.trim(), "a");
      group.querySelector<HTMLButtonElement>(`.split-pane-actions [aria-label="${action}"]`)!.click();
      if (action === "Share conversation") {
        document.querySelector<HTMLButtonElement>(".session-share-dialog .project-dialog-actions button")!.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const expected = action === "Archive session" ? "POST /api/sessions/a" : "POST /api/sessions/a/share";
      assert.ok(requests.includes(expected), JSON.stringify(requests));
      assert.ok(!requests.includes("POST /api/sessions/b"));
      assert.ok(!requests.includes("POST /api/sessions/b/share"));
      if (action === "Archive session") assert.ok(!group.isConnected);
    });
  });
}
