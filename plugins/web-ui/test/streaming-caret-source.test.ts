import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

const caretSelector = (indent: string): string =>
  [
    ".streaming-text.live-stream .stream-tail > div > :is(p, h1, h2, h3, h4, h5, h6):last-child::after,",
    ".streaming-text.live-stream .stream-tail > div > :is(ul, ol):last-child > li:last-child::after,",
    ".streaming-text.live-stream .stream-tail > div > blockquote:last-child > p:last-child::after {",
  ]
    .map((line) => indent + line)
    .join("\n");

test("the live tail block keeps the stream-tail class the caret hangs off", () => {
  assert.match(chat, /<markdown-block\s+class="stream-tail"/);
  assert.match(chat, /class="streaming-text \$\{isStreaming \? "live-stream" : ""\}"/);
});

test("the caret is a breathing pseudo-element on the last block inside the mini-lit wrapper div", () => {
  const rule = css.indexOf(caretSelector(""));
  assert.ok(rule >= 0, "caret selector reaches through the markdown-block wrapper div");
  const body = css.slice(rule, css.indexOf("\n}", rule));
  assert.match(body, /content: "";/);
  assert.match(body, /width: 2px;/);
  assert.match(body, /var\(--brand-accent\)/);
  assert.match(body, /animation: caret-breathe 1\.05s ease-in-out infinite;/);
  assert.match(css, /@keyframes caret-breathe \{[^@]*opacity: 0\.35;\s*transform: scaleY\(0\.82\);/);
  assert.doesNotMatch(css, /\.stream-tail > :is\(p/);
});

test("the first streamed paragraph rises out of the thinking row once via @starting-style", () => {
  assert.match(css, /\.streaming-text\.live-stream \{\s*transition:\s*opacity 240ms ease-out,\s*transform 320ms/);
  assert.match(
    css,
    /@starting-style \{\s*\.streaming-text\.live-stream \{\s*opacity: 0;\s*transform: translateY\(5px\);/,
  );
});

test("reduced motion keeps a static caret and drops the rise without touching the thinking sheen", () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map((m) => m[0]);
  const caretBlock = blocks.find((block) => block.includes(caretSelector("  ")));
  assert.ok(caretBlock, "a reduced-motion block covers the caret");
  assert.match(caretBlock, /\.streaming-text\.live-stream \{\s*transition: none;/);
  assert.match(caretBlock, /::after \{\s*animation: none;\s*opacity: 1;/);
  assert.match(css, /animation: thinking-sheen 2\.55s linear infinite;/);
});
