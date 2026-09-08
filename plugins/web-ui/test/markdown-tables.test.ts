import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const source = [
  "| Flavor | Batches | Price |",
  "|:---|:---:|---:|",
  "| Rocky Road | 12 | $4.00 |",
  "| Pistachio | 3 | $1.50 |",
].join("\n");

test("a markdown table rendered through markdown() keeps its grid and alignment after sanitization", async () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: "http://localhost/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { render } = await import("lit");
    const { markdown } = await vite.ssrLoadModule("/src/message-markdown.ts");
    const { installMarkdownSanitizer } = await vite.ssrLoadModule("/src/markdown-sanitize.ts");
    installMarkdownSanitizer();
    const host = dom.window.document.getElementById("host")!;
    render(markdown(source), host);
    const block = host.querySelector("markdown-block") as HTMLElement & { updateComplete: Promise<boolean> };
    await block.updateComplete;

    const grid = block.querySelector("table")!;
    assert.equal(grid.querySelectorAll("thead th").length, 3);
    assert.equal(grid.querySelectorAll("tbody tr").length, 2);
    assert.equal(grid.querySelector("th:nth-child(2)")!.getAttribute("align"), "center");
    assert.equal(grid.querySelector("tbody td:nth-child(3)")!.getAttribute("align"), "right");
    assert.equal(grid.querySelector("tbody td")!.textContent, "Rocky Road");
    assert.equal(grid.parentElement!.tagName, "DIV");
  } finally {
    await vite.close();
    dom.window.close();
  }
});
