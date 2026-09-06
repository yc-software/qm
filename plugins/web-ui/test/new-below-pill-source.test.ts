import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the pill mounts first in the dock only while a run is live and pins via the forced scroll path", () => {
  assert.match(chat, /<div class="chat-bottom-dock">\s*\$\{newBelowPill\(agent\)\}/);
  assert.match(chat, /function newBelowPill\(agent: Agent\)[\s\S]*?if \(!runIsLive\(agent\)\) return nothing;/);
  assert.match(chat, /class="new-below-pill" \?inert=\$\{stickToBottom\} @click=\$\{scrollToBottom\}/);
  assert.match(chat, /function liveWorkDock\(agent: Agent\)[\s\S]*?if \(!runIsLive\(agent\)\) return nothing;/);
});

test("scrolling toggles a host class and inert without a redraw; scrollToBottom clears both", () => {
  assert.match(chat, /clientHeight <= 120;\s*syncScrolledUp\(\);/);
  assert.match(chat, /scrollTranscript\(true\);\s*syncScrolledUp\(\);/);
  const sync = chat.match(/function syncScrolledUp\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(sync, /classList\.toggle\("scrolled-up", !stickToBottom\)/);
  assert.match(sync, /pill\.inert = stickToBottom/);
  assert.ok(!/draw|render\(/.test(sync), "scroll must not trigger a redraw");
});

test("the pill hides via opacity and pointer-events, animates transform and opacity only, and drops motion when asked", () => {
  assert.match(css, /\.chat-bottom-dock \{\s*position: relative;/);
  const pill = css.match(/\n\.new-below-pill \{[^}]*\}/)?.[0] ?? "";
  assert.match(pill, /opacity: 0;\s*pointer-events: none;/);
  assert.match(pill, /transition:\s*opacity 160ms ease,\s*transform 220ms cubic-bezier/);
  assert.match(
    css,
    /\.scrolled-up \.new-below-pill \{\s*opacity: 1;\s*pointer-events: auto;\s*transform: translate\(-50%, -100%\);/,
  );
  assert.match(css, /\.dark \.new-below-pill \{\s*background: color-mix\(in srgb, var\(--popover\)/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.new-below-pill \{\s*transition: none;\s*transform: translate\(-50%, -100%\);\s*\}\s*\}/,
  );
});
