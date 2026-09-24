import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import type { DensityTier } from "../src/density.ts";

test("inbox count slots stay reserved while badges and exact accessible counts update", async () => {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main></main><div id="inbox"></div>', {
    url: "http://localhost/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let pane: { dispose(): void } | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { inboxState, mountInboxPane, resetInboxState } = await vite.ssrLoadModule("/src/inbox.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "sam", org: "test", permissions: ["inbox"] };
    inboxState.loaded = true;
    inboxState.fetchedAt = Date.now();
    inboxState.selected = [{ id: "email", name: "Email", count: 0 }];
    const host = document.getElementById("inbox")!;
    let density: DensityTier = "full";
    let redraw = () => {};
    pane = mountInboxPane({
      host,
      viewId: "all",
      density: () => density,
      onDensityChange: (handler: () => void) => (redraw = handler),
    });
    const slots = [...host.querySelectorAll<HTMLElement>(".inbox-chip-count-slot")];
    assert.equal(slots.length, 2);
    for (const count of [0, 1, 19, 99, 100, 1234, 0]) {
      inboxState.total = count;
      inboxState.selected[0].count = count;
      redraw();
      assert.deepEqual([...host.querySelectorAll(".inbox-chip-count-slot")], slots);
      for (const slot of slots) {
        const tab = slot.closest<HTMLButtonElement>("button")!;
        const badge = slot.querySelector<HTMLElement>(".inbox-chip-count")!;
        assert.match(tab.getAttribute("aria-label")!, new RegExp(`, ${count} items$`));
        assert.equal(badge.textContent?.trim(), count > 99 ? "99+" : String(count));
        assert.equal(badge.getAttribute("aria-hidden"), "true");
        assert.equal(getComputedStyle(slot).width, "30px");
        assert.equal(getComputedStyle(slot).display, "inline-flex");
        assert.notEqual(getComputedStyle(badge).width, "30px");
        assert.equal(getComputedStyle(badge).visibility, count === 0 ? "hidden" : "visible");
        if (count > 99) {
          tab.focus();
          assert.equal(document.querySelector('[role="tooltip"].visible')?.textContent, `${count} items`);
          tab.blur();
          assert.equal(document.querySelector('[role="tooltip"].visible'), null);
          tab.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
          assert.equal(document.querySelector('[role="tooltip"].visible')?.textContent, `${count} items`);
          tab.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
        }
      }
    }
    for (const tier of ["compact", "card", "strip", "full"] as const) {
      density = tier;
      redraw();
      for (const slot of slots)
        assert.equal(getComputedStyle(slot).display, tier === "card" || tier === "strip" ? "none" : "inline-flex");
    }
    resetInboxState();
    assert.deepEqual(errors, []);
  } finally {
    pane?.dispose();
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
