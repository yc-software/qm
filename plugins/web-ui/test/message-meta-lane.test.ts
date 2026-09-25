import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("message actions fit their lane and stack above sticky rows", () => {
  assert.match(css, /\.message-meta\s*{[^}]*z-index: 4;[^}]*height: var\(--meta-lane\);/s);
  assert.match(css, /\.msg-copy\s*{[^}]*width: var\(--meta-lane\);[^}]*height: var\(--meta-lane\);/s);
});

test("the action buttons clear the 24px minimum target, and the lane they reserve grows with them", () => {
  assert.match(css, /\n:root \{[^}]*--meta-lane: 24px;/s);
  assert.match(css, /\[data-density="compact"\][^{]*\{[^}]*--meta-lane: 20px;/s);
  assert.match(css, /\.message-meta\s*\{[^}]*gap: 8px;/s);
  assert.doesNotMatch(css, /\.msg-copy::after/);
});
