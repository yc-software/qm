import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { decorateTextCodeBlocks, normalizePlainTextFences } from "../src/text-code.ts";

test("plain-text fences lose only their surrounding blank lines", () => {
  const source = "before\n```text\n\n  \nhello\n\n```\nafter\n```ts\n\nconst x = 1;\n\n```";
  assert.equal(normalizePlainTextFences(source), "before\n```text\nhello\n```\nafter\n```ts\n\nconst x = 1;\n\n```");
});

test("plain-text fence normalization follows Markdown fence grammar", () => {
  const cases = [
    ["```\n\nplain\n\n```", "```\nplain\n```"],
    ["~~~text\n\nplain\n\n~~~", "~~~text\nplain\n~~~"],
    ["````text title\n\n```\n\n````", "````text title\n```\n````"],
    ["    ```text\n\nliteral\n\n    ```", "    ```text\n\nliteral\n\n    ```"],
    ["\t```text\n\nliteral\n\n\t```", "\t```text\n\nliteral\n\n\t```"],
    ["````js\n```text\n\nliteral\n\n```\n````", "````js\n```text\n\nliteral\n\n```\n````"],
    ["~~~js\n```text\n\nliteral\n\n```\n~~~", "~~~js\n```text\n\nliteral\n\n```\n~~~"],
  ];

  for (const [source, expected] of cases) assert.equal(normalizePlainTextFences(source!), expected);
});

test("text-block expansion is local and preserves rendered code nodes", () => {
  const dom = new JSDOM(`<main>
    <code-block language="text"><div><div><span>text</span><copy-button></copy-button></div><div><pre><code>same<!--lit-marker--></code></pre></div></div></code-block>
    <code-block language="text"><div><div><span>text</span><copy-button></copy-button></div><div><pre><code>same<!--lit-marker--></code></pre></div></div></code-block>
  </main>`);
  const root = dom.window.document.querySelector("main")!;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("code-block"));
  for (const pre of root.querySelectorAll("pre")) Object.defineProperty(pre, "scrollHeight", { value: 120 });
  const renderedCode = blocks[0]!.querySelector("code")!.innerHTML;

  decorateTextCodeBlocks(root);
  decorateTextCodeBlocks(root);

  const firstButton = blocks[0]!.querySelector<HTMLButtonElement>(".text-code-toggle")!;
  assert.equal(root.querySelectorAll(".text-code-toggle").length, 2);
  assert.equal(blocks[0]!.querySelector("code")!.innerHTML, renderedCode);
  assert.equal(blocks[0]!.dataset.expanded, "false");
  assert.equal(blocks[1]!.dataset.expanded, "false");

  firstButton.click();

  assert.equal(blocks[0]!.dataset.expanded, "true");
  assert.equal(blocks[1]!.dataset.expanded, "false");
  assert.equal(firstButton.textContent, "Show less");
  assert.equal(firstButton.getAttribute("aria-expanded"), "true");
});

test("source fences get a line gutter and diff fences mark changed rows without touching rendered code", () => {
  const dom = new JSDOM(`<main>
    <code-block language="ts"><div><div><span>ts</span><copy-button></copy-button></div><div><pre><code class="hljs">const a = 1;
const b = 2;
<!--lit-marker--></code></pre></div></div></code-block>
    <code-block language="diff"><div><div><span>diff</span><copy-button></copy-button></div><div><pre><code>--- a
+++ b
 same
-old
+new
</code></pre></div></div></code-block>
    <code-block language="ts"><div><div><span>ts</span><copy-button></copy-button></div><div><pre><code>one</code></pre></div></div></code-block>
  </main>`);
  const root = dom.window.document.querySelector("main")!;
  const [source, diff, single] = Array.from(root.querySelectorAll<HTMLElement>("code-block"));
  const renderedCode = source!.querySelector("code")!.innerHTML;

  decorateTextCodeBlocks(root);
  decorateTextCodeBlocks(root);

  const gutters = source!.querySelectorAll(".code-gutter");
  assert.equal(gutters.length, 1);
  assert.equal(gutters[0]!.getAttribute("aria-hidden"), "true");
  assert.equal(source!.querySelector("pre")!.firstElementChild, gutters[0]);
  assert.deepEqual(
    Array.from(gutters[0]!.children, (cell) => cell.textContent),
    ["1", "2"],
  );
  assert.equal(source!.querySelector("code")!.innerHTML, renderedCode);
  assert.deepEqual(
    Array.from(diff!.querySelectorAll(".code-gutter > span"), (cell) => [cell.className, cell.textContent]),
    [
      ["", " "],
      ["", " "],
      ["", " "],
      ["code-line-del", "-"],
      ["code-line-add", "+"],
    ],
  );
  assert.equal(single!.querySelector(".code-gutter"), null);
  assert.equal(root.querySelector(".text-code-toggle"), null);
});

const TS_FENCE = `<code-block language="ts"><div><div><span>ts</span><copy-button></copy-button></div><div><pre><code>const a = 1;
const b = 2;
</code></pre></div></div></code-block>`;

test("a settled fence keeps its gutter as-is while a streaming fence grows in place", () => {
  const dom = new JSDOM(`<main>
    <article class="message-row assistant-row">${TS_FENCE}</article>
    <article class="message-row assistant-row streaming">${TS_FENCE}</article>
  </main>`);
  const root = dom.window.document.querySelector("main")!;
  const [settled, streaming] = Array.from(root.querySelectorAll<HTMLElement>("code-block"));
  const cells = (block: HTMLElement) => Array.from(block.querySelectorAll(".code-gutter > span"));

  decorateTextCodeBlocks(root);
  const streamingCells = cells(streaming!);
  for (const block of [settled!, streaming!]) block.querySelector("code")!.textContent += "const c = 3;\n";
  decorateTextCodeBlocks(root);

  assert.deepEqual(
    cells(settled!).map((cell) => cell.textContent),
    ["1", "2"],
  );
  const grown = cells(streaming!);
  assert.deepEqual(
    grown.map((cell) => cell.textContent),
    ["1", "2", "3"],
  );
  assert.deepEqual(grown.slice(0, 2), streamingCells);

  settled!.setAttribute("language", "diff");
  decorateTextCodeBlocks(root);

  assert.deepEqual(
    cells(settled!).map((cell) => cell.textContent),
    [" ", " ", " "],
  );
  assert.equal(settled!.querySelectorAll(".code-gutter").length, 1);
});

test("a streaming diff fence refreshes its last gutter mark once the line settles", () => {
  const dom = new JSDOM(`<main><article class="message-row assistant-row streaming">
    <code-block language="diff"><div><div><span>diff</span><copy-button></copy-button></div><div><pre><code> same

</code></pre></div></div></code-block>
  </article></main>`);
  const root = dom.window.document.querySelector("main")!;
  const code = root.querySelector("code")!;
  const cells = () =>
    Array.from(root.querySelectorAll(".code-gutter > span"), (cell) => [cell.className, cell.textContent]);

  decorateTextCodeBlocks(root);
  assert.deepEqual(cells(), [
    ["", " "],
    ["", " "],
  ]);
  const first = root.querySelector(".code-gutter > span");

  code.textContent = " same\n-old\n";
  decorateTextCodeBlocks(root);
  assert.deepEqual(cells(), [
    ["", " "],
    ["code-line-del", "-"],
  ]);

  code.textContent = " same\n-old\n+new\n";
  decorateTextCodeBlocks(root);
  assert.deepEqual(cells(), [
    ["", " "],
    ["code-line-del", "-"],
    ["code-line-add", "+"],
  ]);
  assert.equal(root.querySelector(".code-gutter > span"), first);
});
