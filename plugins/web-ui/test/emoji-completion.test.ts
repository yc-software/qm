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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      emoji: {
        party_blob: "https://emoji.slack-edge.com/test/blob.gif",
        yay_blob: "alias:party_blob",
        loop: "alias:loop",
        broken: "alias:missing",
        yay: "alias:thumbsup",
        unsafe: "javascript:alert(1)",
      },
    });
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { render } = await server.ssrLoadModule("lit");
    const { composerInput } = await server.ssrLoadModule("/src/composer-input.ts");
    const { loadWorkspaceEmoji } = await server.ssrLoadModule("/src/workspace-emoji.ts");
    const catalog = await loadWorkspaceEmoji();
    assert.deepEqual(
      catalog.map((row: { n: string }) => row.n),
      ["party_blob", "yay_blob", "yay"],
    );
    assert.equal(catalog.find((row: { n: string }) => row.n === "yay").c, ":yay:");
    const root = dom.window.document.querySelector("#root")!;
    let draft = "";
    let sends = 0;
    render(
      composerInput({
        value: draft,
        placeholder: "Reply in Slack as Alice",
        disabled: false,
        onInput: (e: Event) => {
          draft = (e.target as HTMLTextAreaElement).value;
        },
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter") sends++;
        },
      }),
      root,
    );
    const input = root.querySelector("textarea")!;
    input.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const type = (value: string, caret = value.length, isComposing = false) => {
      input.value = value;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", isComposing }));
    };
    const key = (key: string) =>
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    type(":yay_bl");
    assert.ok(root.querySelector('img[src="https://emoji.slack-edge.com/test/blob.gif"]'));
    key("Enter");
    assert.equal(draft, ":yay_blob:");
    assert.equal(sends, 0);
    assert.equal(root.querySelector('[role="listbox"]'), null);
    type(":party_blob:");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(draft, ":party_blob:");
    for (const shortcode of [":sweat-smile:", ":sweat_smile:", ":thumbsup:", ":+1:"]) {
      type(shortcode);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(draft, shortcode.includes("sweat") ? "😅" : "👍");
    }
    type("hello :sweat-smile: world", 19);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    type(":smile");
    input.value = "";
    key("Enter");
    assert.equal(input.value, "");
    assert.equal(root.querySelector('[role="listbox"]'), null);
    type("hello :smile");
    input.setSelectionRange(0, input.value.length);
    key("Enter");
    assert.equal(input.value, "hello :smile");
    assert.equal(root.querySelector('[role="listbox"]'), null);
    type(":sweat-sm");
    root.querySelector<HTMLButtonElement>('[role="option"]')!.click();
    assert.equal(draft, "😅");
    type(":smile");
    render(null, root);
    assert.equal(root.querySelector('[role="listbox"]'), null);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
