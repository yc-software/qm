import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost" });
for (const key of [
  "localStorage",
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "CSSStyleSheet",
  "ShadowRoot",
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { StableMarkdown } = await import("../src/stable-markdown.ts");
const { installMarkdownSanitizer } = await import("../src/markdown-sanitize.ts");
installMarkdownSanitizer();

async function mount(content: string): Promise<InstanceType<typeof StableMarkdown>> {
  const block = new StableMarkdown();
  document.body.append(block);
  block.content = content;
  await block.updateComplete;
  return block;
}

test("appending text preserves existing paragraphs, formatted nodes and selection", async () => {
  const block = await mount("A **stable phrase** followed by text");
  const paragraph = block.querySelector("p")!;
  const strong = block.querySelector("strong")!;
  const selection = dom.window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(strong);
  selection.removeAllRanges();
  selection.addRange(range);
  block.content += " and more text";
  await block.updateComplete;
  assert.equal(block.querySelector("p"), paragraph);
  assert.equal(block.querySelector("strong"), strong);
  assert.equal(selection.toString(), "stable phrase");
  assert.match(block.textContent!, /and more text/);
  block.remove();
});

test("completed tables and code components remain mounted while the reply grows", async () => {
  const block = await mount("| name | value |\n| --- | --- |\n| alpha | 1 |\n\n```js\nconst x = 1;\n```\n\nNext");
  const table = block.querySelector("table");
  const code = block.querySelector("code-block");
  assert.ok(code);
  await (code as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
  const marker = document.createElement("i");
  code.append(marker);
  code.setAttribute("data-expanded", "true");
  code.classList.add("text-code-collapsible");
  block.content += " paragraph";
  await block.updateComplete;
  assert.equal(block.querySelector("table"), table);
  assert.equal(block.querySelector("code-block"), code);
  assert.equal(code.getAttribute("data-expanded"), "true");
  assert.ok(code.classList.contains("text-code-collapsible"));
  assert.ok(marker.isConnected, "a custom element owns its rendered children");
  block.remove();
});

test("reference definitions can update earlier text without segment-boundary drift", async () => {
  const block = await mount("intro ".repeat(350) + "[reference][target]\n\nNext paragraph");
  block.content += "\n\n[target]: https://example.com\n";
  await block.updateComplete;
  assert.equal(block.querySelector("a")?.href, "https://example.com/");
  block.remove();
});

test("replacement text and unsafe links are handled by the existing markdown sanitization", async () => {
  const block = await mount("Long original **reply**");
  block.content = "[unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>";
  await block.updateComplete;
  assert.ok(!block.innerHTML.includes('href="javascript:'));
  assert.equal(block.querySelector("img"), null);
  assert.ok(!block.textContent!.includes("Long original"));
  block.remove();
});

test("selection inside a growing text node survives append-only updates", async () => {
  const el = await mount("a growing paragraph");
  const text = el.querySelector("p")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 9);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  el.content = "a growing paragraph with more words";
  await el.updateComplete;
  assert.equal(selection.toString(), "growing");
  assert.equal(el.querySelector("p")!.firstChild, text);
});
