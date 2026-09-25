import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div id='root'></div>");
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
});
const { render } = await import("lit");
const { sessionStatusMark } = await import("../src/session-status.ts");
const root = document.getElementById("root")!;

test("session status renders safe text, exposes a keyboard tooltip, updates and clears", () => {
  render(sessionStatusMark({ emoji: "✅", text: "PR merged <script>" }), root);
  const mark = root.querySelector<HTMLElement>(".session-status")!;
  assert.equal(mark.textContent, "✅");
  assert.equal(mark.getAttribute("aria-label"), "PR merged <script>");
  mark.dispatchEvent(new dom.window.FocusEvent("focus"));
  assert.equal(document.querySelector(".qm-tooltip")?.textContent, "PR merged <script>");
  assert.equal(document.querySelector("script"), null);
  render(sessionStatusMark({ emoji: "🚀", text: "Live in production" }), root);
  assert.equal(mark.textContent, "🚀");
  assert.equal(document.querySelector(".qm-tooltip")?.textContent, "Live in production");
  render(sessionStatusMark(null), root);
  assert.equal(root.querySelector(".session-status"), null);
  assert.equal(document.querySelector(".qm-tooltip.visible"), null);
});
