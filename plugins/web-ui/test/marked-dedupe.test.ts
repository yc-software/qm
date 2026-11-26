import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import "../src/marked-dedupe.ts";

type Ext = { name: string; level: "inline"; start: (s: string) => number; tokenizer: () => undefined };
const ext = (name: string): Ext => ({
  name,
  level: "inline",
  start: (s) => s.indexOf("%"),
  tokenizer: () => undefined,
});
const inlineCount = (): number =>
  (marked.defaults as { extensions?: { inline?: unknown[] } }).extensions?.inline?.length ?? 0;

test("re-registering the same extensions is a no-op — the tokenizer list stops growing", () => {
  marked.use({ extensions: [ext("dedupe-a"), ext("dedupe-b")] });
  const after = inlineCount();
  assert.ok(after >= 2, "first registration lands");
  for (let i = 0; i < 50; i++) marked.use({ extensions: [ext("dedupe-a"), ext("dedupe-b")] });
  assert.equal(inlineCount(), after);
});

test("a config carrying more than extensions always passes through", () => {
  marked.use({ extensions: [ext("dedupe-c")] });
  const before = inlineCount();
  marked.use({ extensions: [ext("dedupe-c")], breaks: false });
  assert.equal(inlineCount(), before + 1, "extension-plus-options config is not swallowed");
});

test("a config with no extensions passes through untouched", () => {
  marked.use({ breaks: false });
  assert.equal((marked.defaults as { breaks?: boolean }).breaks, false);
});

test("a partially-new extension list registers", () => {
  marked.use({ extensions: [ext("dedupe-a"), ext("dedupe-new")] });
  assert.match(marked.parse("hello *world*") as string, /<em>world<\/em>/);
});

test("single-dollar inline math is dropped while block math, LaTeX math and dollars in code render intact", async () => {
  const before = inlineCount();
  marked.use({ extensions: [ext("inlineMathDollar")], breaks: false });
  assert.equal(inlineCount(), before);

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
  const renderBlock = async (content: string) => {
    const el = new StableMarkdown();
    document.body.append(el);
    el.content = content;
    await el.updateComplete;
    const html = el.innerHTML;
    const codes = [...el.querySelectorAll("code-block")].map((cb) =>
      Buffer.from(cb.getAttribute("code") ?? "", "base64").toString("utf8"),
    );
    const hasKatex = Boolean(el.querySelector(".katex"));
    el.remove();
    return { html, codes, hasKatex };
  };

  const currency = await renderBlock("SPCX priced at $135, opened $150, closed around $161");
  assert.equal(currency.hasKatex, false);
  assert.match(currency.html, /\$135, opened \$150, closed around \$161/);

  const fourTick = await renderBlock("````markdown\n```sh\necho $HOME\n```\n````");
  assert.deepEqual(fourTick.codes, ["```sh\necho $HOME\n```\n"]);

  const doubleTick = await renderBlock("Use ``echo `$HOME` `` here");
  assert.match(doubleTick.html, /<code>echo `\$HOME` <\/code>/);

  const quoteCode = await renderBlock(">     echo $HOME");
  assert.deepEqual(quoteCode.codes, ["echo $HOME\n"]);

  const tildeAndCurrency = await renderBlock("~~~\n```sh\n~~~\n\nPrice is $5 to $10\n\n```sh\necho $HOME\n```");
  assert.equal(tildeAndCurrency.hasKatex, false);
  assert.match(tildeAndCurrency.html, /Price is \$5 to \$10/);
  assert.deepEqual(tildeAndCurrency.codes, ["```sh\n", "echo $HOME\n"]);

  const blockMath = await renderBlock("$$x^2$$");
  assert.equal(blockMath.hasKatex, true);

  const latexMath = await renderBlock("\\(x^2\\) and \\[y\\]");
  assert.equal(latexMath.hasKatex, true);
});
