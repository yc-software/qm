import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("pane visibility changes preserve the transcript viewport", () => {
  const handler = split.match(/onDidVisibilityChange\(\(e\) => \{[\s\S]*?\}\);/)?.[0] ?? "";
  assert.doesNotMatch(handler, /forceScroll/, "grid visibility is presentation state, not scroll intent");
  assert.match(handler, /this\.syncDensity\(\)/, "shown panes still refresh their responsive presentation");
});

test("responsive pane summaries do not replace the transcript scroller", () => {
  assert.match(chat, /glanceTier\s*\?\s*paneGlance\([^)]+\)\s*:\s*nothing[\s\S]*?<section class="chat-scroll"/);
  assert.doesNotMatch(
    chat,
    /glanceTier\s*\?\s*paneGlance\([^)]+\)\s*:\s*html`<section class="chat-scroll"/,
    "presentation changes must not destroy the element that owns scrollTop",
  );
});

test("hidden panes retain their last meaningful density", () => {
  const fn = split.match(/private syncDensity\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /if \(!next\s*\|\|\s*next === this\.density\) return;/);
});
