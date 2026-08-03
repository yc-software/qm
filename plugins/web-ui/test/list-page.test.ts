import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createViteTestServer } from "./vite-test-server.ts";

test("list search uses its purpose as an accessible name", () => {
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  assert.equal(source.includes("aria-label=${o.search.placeholder"), true);
});

test("list refresh control uses the page locale", async () => {
  const dom = new JSDOM('<!doctype html><meta name="qm-locale" content="ja"><div id="app"></div>', {
    url: "http://localhost/crons",
  });
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
    HTMLDialogElement: dom.window.HTMLDialogElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    SubmitEvent: dom.window.SubmitEvent,
    InputEvent: dom.window.InputEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const vite = await createViteTestServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
  });
  try {
    const [{ render }, { listPageTpl }] = await Promise.all([
      vite.ssrLoadModule("lit"),
      vite.ssrLoadModule("/src/list-page.ts"),
    ]);
    const root = document.querySelector<HTMLElement>("#app")!;
    render(listPageTpl({ title: "定期実行", onRefresh: () => undefined, rows: [], empty: "" }), root);
    const refresh = root.querySelector<HTMLButtonElement>(".pane-refresh")!;
    assert.equal(refresh.title, "更新");
    assert.equal(refresh.getAttribute("aria-label"), "更新");
  } finally {
    await vite.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
