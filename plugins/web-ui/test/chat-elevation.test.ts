import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("transcript edges do not blur or mask the response", () => {
  assert.doesNotMatch(css, /\.chat-scroll::(?:before|after)/);
  assert.doesNotMatch(css, /\.message-stack \.user-row[^{}]*::after/);
  assert.doesNotMatch(css, /--chat-edge-fade/);
});

test("the pinned prompt and composer have elevated solid surfaces", () => {
  const pinned =
    css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) > \.user-bubble \{[^}]*\}/)?.[0] ?? "";
  const composer = css.match(/^\.composer-wrap \{[^}]*\}/m)?.[0] ?? "";
  assert.match(pinned, /box-shadow: var\(--chat-surface-shadow\);/);
  assert.match(composer, /background: var\(--background\);/);
  assert.match(composer, /box-shadow: var\(--chat-surface-shadow\);/);
});

test("prompt elevation is shared by every transcript without scroll-handler state", () => {
  const root = css.match(/:root \{[^}]*\}/)?.[0] ?? "";
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.match(root, /--chat-surface-shadow:/);
  assert.doesNotMatch(css, /\.user-row\.stuck/);
  assert.doesNotMatch(chat, /markStuckUserRow/);
});
