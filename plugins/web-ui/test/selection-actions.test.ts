import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<!doctype html><main>
    <section class="chat-scroll"><div class="message-stack">
      <p id="inside">Churn it first thing Saturday.</p>
      <p id="inside2">Fold the pistachios in last.</p>
    </div></section>
    <p id="outside">Pistachio holds the top slot.</p>
    <textarea id="composer"></textarea>
  </main>`,
);
const { window } = dom;
const { document } = window;
Object.defineProperty(globalThis, "document", { configurable: true, value: document });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: window.HTMLElement });
Object.defineProperty(globalThis, "Event", { configurable: true, value: window.Event });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
const zeroRect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
window.Range.prototype.getBoundingClientRect = () => zeroRect as DOMRect;

const { registerSelectionActions } = await import("../src/selection-actions.ts");
const inserted: string[] = [];
registerSelectionActions(() => ({ insertText: (text) => void inserted.push(text) }));

const selectionChanged = (): boolean => document.dispatchEvent(new window.Event("selectionchange"));

function select(id: string): void {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById(id)!);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selectionChanged();
  selection.addRange(range);
  selectionChanged();
}

function key(type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new window.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
  document.activeElement!.dispatchEvent(e);
  return e;
}

const toolbar = (): HTMLElement | null => document.querySelector<HTMLElement>('.selection-toolbar[role="toolbar"]');
const scroller = document.querySelector<HTMLElement>(".chat-scroll")!;
const quote = "> Churn it first thing Saturday.\n\n";

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

test("Escape hides the toolbar and the same selection stays dismissed until a new one is made", () => {
  select("inside");
  assert.ok(toolbar());
  key("keydown", "Escape");
  key("keyup", "Escape");
  assert.equal(toolbar(), null);
  selectionChanged();
  assert.equal(toolbar(), null);
  select("inside2");
  assert.ok(toolbar());
});

test("scrolling keeps the toolbar while the selection is on screen and hides it once the selection is gone", () => {
  select("inside");
  scroller.dispatchEvent(new window.Event("scroll"));
  assert.ok(toolbar());
  document.getSelection()!.removeAllRanges();
  scroller.dispatchEvent(new window.Event("scroll"));
  assert.equal(toolbar(), null);
});

test("Quote inserts the quoted passage and closes", () => {
  inserted.length = 0;
  select("inside");
  toolbar()!.querySelector<HTMLButtonElement>('[data-action="quote"]')!.click();
  assert.deepEqual(inserted, [quote]);
  assert.equal(toolbar(), null);
});

test("Explain inserts the quote with the prompt beneath it", () => {
  inserted.length = 0;
  select("inside");
  toolbar()!.querySelector<HTMLButtonElement>('[data-action="explain"]')!.click();
  assert.deepEqual(inserted, [`${quote}Explain this.`]);
});

test("Ask inserts the typed prompt beneath the quote on Enter or the send button", () => {
  for (const send of ["enter", "button"]) {
    inserted.length = 0;
    select("inside");
    const input = toolbar()!.querySelector<HTMLInputElement>("input")!;
    assert.equal(toolbar()!.querySelector<HTMLButtonElement>('[data-action="ask"]')!.disabled, true);
    input.value = "Make it shorter";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    if (send === "enter") input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else toolbar()!.querySelector<HTMLButtonElement>(".selection-toolbar-send")!.click();
    assert.deepEqual(inserted, [`${quote}Make it shorter`]);
    assert.equal(toolbar(), null);
  }
});

test("Tab enters the toolbar only from the transcript, skips hidden controls, and leaves quietly", () => {
  const composer = document.getElementById("composer") as HTMLTextAreaElement;
  select("inside");
  composer.focus();
  assert.equal(key("keydown", "Tab").defaultPrevented, false);
  assert.equal(document.activeElement, composer);

  composer.blur();
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = ".selection-toolbar-input { display: none }";
  assert.equal(key("keydown", "Tab").defaultPrevented, true);
  assert.equal(document.activeElement, toolbar()!.querySelector('[data-action="quote"]'));
  style.remove();

  key("keydown", "Escape");
  assert.equal(toolbar(), null);
  assert.equal(document.activeElement, scroller);
  assert.ok(scroller.hasAttribute("data-quiet-focus"));
  scroller.blur();
  assert.equal(scroller.hasAttribute("data-quiet-focus"), false);

  scroller.focus();
  select("inside2");
  assert.equal(key("keydown", "Tab").defaultPrevented, true);
  assert.equal(document.activeElement, toolbar()!.querySelector("input"));
  toolbar()!.querySelector<HTMLButtonElement>('[data-action="copy"]')!.focus();
  assert.equal(key("keydown", "Tab").defaultPrevented, true);
  assert.equal(toolbar(), null);
  assert.equal(document.activeElement, scroller);
});
