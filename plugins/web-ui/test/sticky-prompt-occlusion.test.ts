import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the pinned prompt hides the transcript by painting over it, not by fading it", () => {
  const prompt = css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) \{[^}]*\}/)?.[0] ?? "";

  assert.match(prompt, /position: sticky;/);
  assert.match(prompt, /background: var\(--background\);/);
  assert.match(prompt, /margin-bottom: var\(--chat-prompt-gap\);/);
  assert.doesNotMatch(css, /\.message-stack \.user-row:not\(:has\(~ \.user-row\)\)::after/);
  assert.doesNotMatch(chat, /classList\.toggle\("stuck"/);
});

test("the transcript clips at its own edges — no fade at the topbar or the composer", () => {
  assert.doesNotMatch(css, /\.chat-scroll::(before|after)/);
});

test("no transcript surface dissolves content into the background", () => {
  assert.doesNotMatch(css, /linear-gradient\(\s*to (top|bottom),\s*var\(--background\)/s);
  assert.doesNotMatch(css, /mask-image:/);
});
