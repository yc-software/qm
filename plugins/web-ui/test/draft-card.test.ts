import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
for (const key of [
  "localStorage",
  "window",
  "document",
  "HTMLElement",
  "customElements",
  "Node",
  "Document",
  "CSSStyleSheet",
  "ShadowRoot",
  "Element",
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const writes: string[] = [];
const clipboard = {
  writeText: async (text: string) => {
    writes.push(text);
  },
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard } });
const { DraftCard } = await import("../src/draft-card.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function mount() {
  const card = new DraftCard();
  card.text = "Hello **team**.\n\nThanks!\n";
  document.body.append(card);
  await card.updateComplete;
  await flush();
  return { card, button: card.querySelector("button")! };
}

test("draft copy retains its exact text and original two-second confirmation", async (t) => {
  const { card, button } = await mount();
  t.after(() => card.remove());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalIcon = button.querySelector("svg")!.innerHTML;
  button.click();
  await flush();
  assert.equal(writes.at(-1), "Hello **team**.\n\nThanks!");
  assert.notEqual(button.querySelector("svg")!.innerHTML, originalIcon);
  t.mock.timers.tick(1999);
  await flush();
  assert.notEqual(button.querySelector("svg")!.innerHTML, originalIcon);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(button.querySelector("svg")!.innerHTML, originalIcon);
});

test("draft copy retains original clipboard failure reporting", async (t) => {
  const { card, button } = await mount();
  t.after(() => card.remove());
  const originalIcon = button.querySelector("svg")!.innerHTML;
  const error = new Error("Clipboard denied");
  t.mock.method(clipboard, "writeText", async () => {
    throw error;
  });
  const log = t.mock.method(console, "error", () => {});
  button.click();
  await flush();
  assert.deepEqual(log.mock.calls[0]?.arguments, ["Failed to copy:", error]);
  assert.equal(button.querySelector("svg")!.innerHTML, originalIcon);
});

test("draft copy uses the shared tooltip on hover and focus without a native title", async (t) => {
  const { card, button } = await mount();
  t.after(() => card.remove());
  assert.equal(button.getAttribute("aria-label"), "Copy draft");
  assert.equal(button.title, "");
  assert.equal(card.querySelector("copy-button")!.getAttribute("title"), "");
  button.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  const tooltip = document.querySelector('.qm-tooltip[role="tooltip"]')!;
  assert.equal(tooltip.textContent, "Copy draft");
  assert.ok(tooltip.classList.contains("visible"));
  button.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
  button.focus();
  assert.ok(tooltip.classList.contains("visible"));
  card.remove();
  assert.equal(tooltip.classList.contains("visible"), false);
});
