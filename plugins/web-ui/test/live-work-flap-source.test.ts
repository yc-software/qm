import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const dock = chat.match(/function liveWorkDock\([\s\S]*?\n {2}\}/)?.[0] ?? "";

test("the dock face is keyed on the active tool call so only real step changes remount it", () => {
  assert.match(chat, /import \{ keyed \} from "lit\/directives\/keyed\.js";/);
  assert.match(dock, /const faceKey = work\.stale \? "stale" : \(active\?\.call\?\.seq \?\? "thinking"\);/);
  assert.match(dock, /keyed\(\s*faceKey,\s*html`<span class="live-work-face"/);
  const face = dock.indexOf('class="live-work-face"');
  const toggle = dock.indexOf("live-work-toggle");
  for (const part of ["thinkingOrb(", "live-work-label", "live-work-detail"]) {
    const at = dock.indexOf(part);
    assert.ok(at > face && at < toggle, `${part} renders inside the keyed face`);
  }
  assert.match(dock, /\)\}\s*\$\{expandable \? html`<span class="live-work-toggle"/);
});

test("the face flaps in from a top hinge using only transform and opacity", () => {
  assert.match(css, /\.live-work-line \{\s*perspective: 700px;\s*\}/);
  assert.match(
    css,
    /\.live-work-face \{[^}]*transform-origin: 50% 0%;\s*backface-visibility: hidden;\s*animation: flap-in 380ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\) both;/,
  );
  const keyframes = css.match(/@keyframes flap-in \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(keyframes, /from \{\s*opacity: 0;\s*transform: rotateX\(-78deg\) translateY\(-3px\);/);
  assert.match(keyframes, /to \{\s*opacity: 1;\s*transform: none;/);
  const properties = [...keyframes.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(properties)].sort(), ["opacity", "transform"]);
});

test("the expanded dock wraps inside the face and pins the chevron to the first line", () => {
  assert.match(css, /\.live-work-dock\.expanded \.live-work-face \{\s*flex-wrap: wrap;\s*\}/);
  assert.doesNotMatch(css, /\.live-work-dock\.expanded \.live-work-line \{/);
  assert.match(css, /\.live-work-dock\.expanded \.live-work-toggle \{\s*align-self: flex-start;/);
});

test("reduced motion swaps the face instantly", () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map((m) => m[0]);
  const flapBlock = blocks.find((block) => block.includes(".live-work-face"));
  assert.ok(flapBlock, "a reduced-motion block covers .live-work-face");
  assert.match(flapBlock, /\.live-work-face \{\s*animation: none;\s*\}/);
});
