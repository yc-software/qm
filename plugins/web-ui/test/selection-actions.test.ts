import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<!doctype html><main>
    <section class="chat-scroll"><div class="message-stack"><p id="inside">Churn it first thing Saturday.</p></div></section>
    <p id="outside">Pistachio holds the top slot.</p>
  </main>`,
);
const { window } = dom;
const { document } = window;
Object.defineProperty(globalThis, "document", { configurable: true, value: document });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: window.HTMLElement });
Object.defineProperty(globalThis, "Event", { configurable: true, value: window.Event });
const zeroRect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
window.Range.prototype.getBoundingClientRect = () => zeroRect as DOMRect;

const { registerSelectionActions } = await import("../src/selection-actions.ts");
const calls: Array<{ text: string; opts?: { submit?: boolean } }> = [];
registerSelectionActions(() => ({ insertText: (text, opts) => void calls.push({ text, opts }) }));

function select(id: string): void {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById(id)!);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
}

const toolbar = (): HTMLElement | null => document.querySelector<HTMLElement>('.selection-toolbar[role="toolbar"]');

test("a selection inside a message stack shows the toolbar", () => {
  select("inside");
  assert.ok(toolbar());
  assert.equal(toolbar()!.getAttribute("aria-label"), "Selection actions");
  assert.equal(toolbar()!.querySelector("input")!.getAttribute("placeholder"), "Describe edits");
});

test("a selection outside every message stack shows nothing", () => {
  select("outside");
  assert.equal(toolbar(), null);
});

test("Escape hides the toolbar", () => {
  select("inside");
  assert.ok(toolbar());
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(toolbar(), null);
});

test("Quote hands the quoted passage to the composer and closes", () => {
  select("inside");
  toolbar()!.querySelector<HTMLButtonElement>('[data-action="quote"]')!.click();
  assert.deepEqual(calls, [{ text: "> Churn it first thing Saturday.\n\n", opts: { submit: false } }]);
  assert.equal(toolbar(), null);
});

test("Ask submits the typed prompt beneath the quote", () => {
  calls.length = 0;
  select("inside");
  const input = toolbar()!.querySelector<HTMLInputElement>("input")!;
  assert.equal(toolbar()!.querySelector<HTMLButtonElement>('[data-action="ask"]')!.disabled, true);
  input.value = "Make it shorter";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(calls, [{ text: "> Churn it first thing Saturday.\n\nMake it shorter", opts: { submit: true } }]);
  assert.equal(toolbar(), null);
});
