import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the sticky prompt reserves the space painted by its lower fade", () => {
  const prompt = css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) \{[^}]*\}/)?.[0] ?? "";
  const fade = css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\)::after \{[^}]*\}/)?.[0] ?? "";

  assert.match(prompt, /margin-bottom: var\(--chat-edge-fade\);/);
  assert.match(fade, /top: 100%;/);
  assert.match(fade, /height: var\(--chat-edge-fade, 20px\);/);
});
