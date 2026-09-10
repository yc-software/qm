import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("plain-text code fences stay compact without changing source-code fences", () => {
  assert.match(
    css,
    /code-block\[language="text"\] pre[^}]*margin: 0;[^}]*padding: 4px 8px 8px;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*font-size: 10px;[^}]*line-height: 1\.4;/s,
  );
  assert.match(css, /code-block\[language="text"\] pre code[^}]*font-size: 10px;[^}]*line-height: 1\.4;/s);
  assert.match(css, /code-block\[language="text"\] > div[^}]*display: flex;[^}]*flex-direction: column;/s);
  assert.match(
    css,
    /code-block\[language="text"\] \.text-code-footer[^}]*order: 2;[^}]*height: var\(--meta-lane\);[^}]*justify-content: flex-end;[^}]*padding: 0 2px;[^}]*font-size: 10px;[^}]*opacity: 0;[^}]*pointer-events: none;[^}]*transition: opacity 0\.12s ease;/s,
  );
  assert.match(
    css,
    /code-block\[language="text"\]:hover \.text-code-footer[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
  );
  assert.match(
    css,
    /code-block\[language="text"\] \.text-code-footer:focus-within[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
  );
  assert.match(
    css,
    /@media \(hover: none\)[\s\S]*code-block\[language="text"\] \.text-code-footer[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
  );
  assert.match(
    css,
    /code-block\[language="text"\] copy-button button[^}]*width: var\(--meta-lane\);[^}]*height: var\(--meta-lane\);[^}]*padding: 0;/s,
  );
  assert.doesNotMatch(css, /code-block\[language="text"\] \.text-code-footer[^}]*position: absolute;/s);
  assert.doesNotMatch(css, /markdown-block pre code\s*{[^}]*white-space: pre-wrap;/s);
});

test("long plain-text fences collapse by default and remain expandable", () => {
  assert.match(chat, /requestAnimationFrame\(\(\) => \{\s*decorateTextCodeBlocks\(/);
  assert.match(chat, /normalizePlainTextFences/);
  assert.match(
    css,
    /code-block\.text-code-collapsible\[data-expanded="false"\] \.text-code-body[^}]*max-height: 76px;[^}]*overflow: hidden;/s,
  );
  assert.doesNotMatch(css, /code-block\.text-code-collapsible[^}]*mask-image:/s);
});
