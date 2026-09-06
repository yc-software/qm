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
