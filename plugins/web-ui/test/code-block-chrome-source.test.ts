import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const codeBlock = readFileSync(
  new URL("../node_modules/@mariozechner/mini-lit/dist/CodeBlock.js", import.meta.url),
  "utf8",
);
const copyButton = readFileSync(
  new URL("../node_modules/@mariozechner/mini-lit/dist/CopyButton.js", import.meta.url),
  "utf8",
);
const chrome = css.slice(css.indexOf("\ncode-block {"));

test("mini-lit still renders the light-DOM structure the chrome selectors ride on", () => {
  assert.match(codeBlock, /createRenderRoot\(\) \{\s*return this;/);
  assert.match(codeBlock, /<div class="border[^"]*">\s*(?:<!--[^>]*-->\s*)?<div class="flex[^"]*">\s*<span/);
  assert.match(codeBlock, /<copy-button[^\n]*\.showText=\$\{true\}/);
  assert.match(codeBlock, /<pre[\s\S]*?><code class="hljs/);
  assert.match(copyButton, /this\.copied && this\.showText \? html `<span>/);
});

test("code block chrome targets structure, never mini-lit's Tailwind classes", () => {
  assert.match(chrome, /^code-block > div \{/m);
  assert.match(chrome, /^code-block::after \{[^}]*box-shadow:[^}]*opacity: 0;[^}]*transition: opacity/m);
  assert.match(chrome, /^code-block:hover::after \{\s*opacity: 1;/m);
  assert.match(chrome, /^code-block > div > div:first-child > span:first-child \{[^}]*border-radius: 999px/m);
  assert.doesNotMatch(chrome, /\.(rounded-lg|overflow-hidden|border|flex|hljs|text-xs)\b/);
});

test("copy button hides until hover or focus, stays visible on touch, and pops on Copied!", () => {
  assert.match(chrome, /^code-block copy-button \{\s*opacity: 0;\s*transform: translateY\(-2px\);/m);
  assert.match(chrome, /^code-block:hover copy-button,\s*code-block:focus-within copy-button \{\s*opacity: 1;/m);
  assert.match(chrome, /@media \(hover: none\) \{\s*code-block copy-button \{\s*opacity: 1;/);
  assert.match(chrome, /^code-block copy-button span \{[^}]*animation: code-copied-in/m);
  assert.match(chrome, /@keyframes code-copied-in/);
});

test("streaming caret sits on the tail's code element only and never animates lines", () => {
  assert.match(chrome, /^\.live-stream \.stream-tail code-block pre code::after \{[^}]*animation: code-caret/m);
  assert.match(chrome, /@keyframes code-caret \{\s*to \{\s*opacity: 0;/);
  assert.doesNotMatch(chrome, /(hljs-|\.line|tok-in)/);
});

test("reduced motion stops the chrome transitions and keyframes while keeping copy reachable", () => {
  const reduced = chrome.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reduced, /code-block::after,\s*code-block copy-button \{\s*transition: none;/);
  assert.match(
    reduced,
    /code-block copy-button span,\s*\.live-stream \.stream-tail code-block pre code::after \{\s*animation: none;/,
  );
  assert.doesNotMatch(reduced, /opacity: 0/);
});
