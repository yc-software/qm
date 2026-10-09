import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("emoji completion converts names and accepts suggestions without sending", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLTextAreaElement",
    "Element",
    "Node",
    "InputEvent",
  ] as const) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  try {
    const { html, render } = await server.ssrLoadModule("lit");
    const { emojiCompletion } = await server.ssrLoadModule("/src/emoji-completion.ts");
    const root = dom.window.document.querySelector("#root")!;
    let draft = "";
    let sends = 0;
    render(
      html`<textarea
        ${emojiCompletion()}
        @input=${(e: Event) => {
          draft = (e.target as HTMLTextAreaElement).value;
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") sends++;
        }}
      ></textarea>`,
      root,
    );
    const input = root.querySelector("textarea")!;
    const type = (value: string, caret = value.length, isComposing = false) => {
      input.value = value;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", isComposing }));
    };
    const key = (key: string) =>
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    for (const shortcode of [":sweat-smile:", ":sweat_smile:", ":thumbsup:", ":+1:"]) {
      type(shortcode);
      assert.equal(draft, shortcode.includes("sweat") ? "😅" : "👍");
    }
    type("hello :sweat-smile: world", 19);
    assert.equal(draft, "hello 😅 world");
    assert.equal(input.selectionStart, "hello 😅".length);
    type(":sweat_sm");
    assert.ok(root.querySelector('[role="listbox"]'));
    key("Enter");
    assert.equal(draft, "😅");
    assert.equal(sends, 0);
    assert.equal(root.querySelector('[role="listbox"]'), null);
    type(":sweat");
    key("ArrowDown");
    assert.ok(root.querySelector('[aria-selected="true"]')!.textContent!.includes("sweat"));
    key("Tab");
    assert.ok(!String(draft).includes(":"));
    type(":smile");
    key("Escape");
    assert.equal(draft, ":smile");
    assert.equal(root.querySelector('[role="listbox"]'), null);
    type(":sweat_smile:", 13, true);
    assert.equal(draft, ":sweat_smile:");
    for (const value of [":unknown:", "https://example.com/:smile:", "`code:smile:", "12:30", ":"]) {
      type(value);
      assert.equal(draft, value);
      assert.equal(root.querySelector('[role="listbox"]'), null);
    }
    type(":sweat-sm");
    root.querySelector<HTMLButtonElement>('[role="option"]')!.click();
    assert.equal(draft, "😅");
    type(":smile");
    render(null, root);
    assert.equal(root.querySelector('[role="listbox"]'), null);
  } finally {
    await server.close();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
