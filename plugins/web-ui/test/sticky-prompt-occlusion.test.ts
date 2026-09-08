import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
test("the transcript clips at its own edges — no fade at the topbar or the composer", () => {
  assert.doesNotMatch(css, /\.chat-scroll::(before|after)/);
});

test("no transcript surface dissolves content into the background", () => {
  assert.doesNotMatch(css, /linear-gradient\(\s*to (top|bottom),\s*var\(--background\)/s);
  assert.doesNotMatch(css, /mask-image:/);
});
