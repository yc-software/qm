import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import type { TemplateResult } from "lit";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: { clipboard: { writeText: async () => {} } },
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  customElements: dom.window.customElements,
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { html, render } = await import("lit");
const { Check, Copy } = await import("lucide");
const { copyText, icon } = await import("../src/ui.ts");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

const copy = (event: Event) => void copyText("hello", event.currentTarget as HTMLButtonElement);
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function copyThenRerender(t: TestContext, view: () => TemplateResult): Promise<HTMLButtonElement> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = document.createElement("div");
  render(view(), host);
  const button = host.querySelector("button")!;
  button.click();
  await flush();
  render(view(), host);
  assert.equal(host.querySelector("button"), button, "re-rendering keeps the same button");
  assert.ok(button.classList.contains("copied"), "the copied state is a class on the button");
  return button;
}

test("copying from an icon-only message button survives the next lit render", async (t) => {
  const button = await copyThenRerender(
    t,
    () => html`<button class="msg-copy" @click=${copy}>${icon(Copy, 13)}${icon(Check, 13)}</button>`,
  );
  assert.equal(button.querySelectorAll("svg").length, 2, "both icons stay rendered by lit");
  t.mock.timers.tick(1200);
  assert.ok(!button.classList.contains("copied"));
});

test("copying from a labelled button survives the next lit render", async (t) => {
  const button = await copyThenRerender(
    t,
    () => html`<button class="btn" @click=${copy}>${icon(Copy, 14)}<span>Copy URL</span></button>`,
  );
  assert.equal(button.querySelectorAll("svg").length, 1);
  assert.equal(button.querySelector("span")?.textContent, "Copy URL");
});

test("the copied state is drawn by CSS instead of rewriting button children", () => {
  assert.match(
    css,
    /\.msg-copy\.copied > svg:first-of-type,\s*\.msg-copy:not\(\.copied\) > svg:nth-of-type\(2\) \{\s*display: none;/,
  );
  assert.match(css, /\.btn\.copied > \* \{\s*display: none;/);
  assert.match(css, /\.btn\.copied::after \{\s*content: "Copied";/);
});
