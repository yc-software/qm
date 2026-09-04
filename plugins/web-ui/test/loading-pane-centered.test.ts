import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the loading pane renders chat-loading as the shell's only child", () => {
  const fn = chat.match(/function mountLoadingPane\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /custom-chat-shell/);
  assert.match(fn, /chat-loading/);
});

test("chat-loading spans every shell grid row so the spinner centers vertically", () => {
  const shell = css.match(/\.custom-chat-shell \{[^}]*\}/)?.[0] ?? "";
  assert.match(shell, /display: grid;/, "the shell is a grid, so a lone child needs an explicit row span");
  const block = css.match(/\.chat-loading \{[^}]*\}/)?.[0] ?? "";
  assert.match(block, /grid-row: 1 \/ -1;/, "without spanning all rows the spinner hugs the top auto row");
  assert.match(block, /align-items: center;/);
  assert.match(block, /justify-content: center;/);
});
