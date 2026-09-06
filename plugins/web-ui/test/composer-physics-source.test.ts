import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the composer lifts on focus-within through a pre-rasterized shadow pseudo that only fades", () => {
  const before = css.match(/\n\.composer-wrap::before \{[^}]*\}/)?.[0] ?? "";
  assert.match(before, /z-index: -1;/);
  assert.match(before, /opacity: 0;/);
  assert.match(before, /box-shadow:\s*0 0 0 1px color-mix\(in srgb, var\(--ring\) 45%, var\(--border\)\)/);
  assert.match(before, /transition: opacity 180ms/);
  assert.doesNotMatch(before, /transition:[^;]*box-shadow/);
  assert.match(css, /\.composer-wrap:focus-within \{\s*transform: translateY\(-1px\);\s*\}/);
  assert.match(css, /\.composer-wrap:focus-within::before \{\s*opacity: 1;\s*\}/);
  assert.match(css, /\n\.composer-wrap \{\s*transition: transform 180ms/);
});

test("the send button springs between disabled and enabled and the stop button emerges from its slot", () => {
  const send = css.match(/\n\.send-btn \{[^}]*\}/)?.[0] ?? "";
  assert.match(send, /transition:\s*opacity 120ms ease,\s*transform 220ms cubic-bezier\(0\.34, 1\.45, 0\.64, 1\);/);
  assert.match(css, /\.send-btn:disabled \{\s*transform: scale\(0\.88\);\s*\}/);
  assert.match(css, /\.send-btn:active:not\(:disabled\) \{\s*transform: scale\(0\.92\);\s*transition-duration: 80ms;/);
  assert.match(css, /\.send-btn:hover:not\(:disabled\) svg \{\s*transform: translateY\(-1px\);/);
  assert.match(css, /\.stop-btn:hover svg \{\s*transform: scale\(1\.12\);/);
  assert.match(css, /\.stop-btn \{\s*animation: stop-emerge 260ms/);
  assert.match(css, /@keyframes stop-emerge \{\s*from \{\s*opacity: 0;\s*transform: translateX\(41px\) scale\(0\.6\);/);
  assert.match(css, /\.composer-right \{[^}]*gap: 7px;/);
});

test("reduced motion keeps the composer usable: instant ring, opacity fades only, no emerge", () => {
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.composer-wrap,\s*\.composer-wrap::before \{\s*transition: none;/);
  assert.match(reduced, /\.composer-wrap:focus-within \{\s*transform: none;/);
  assert.match(reduced, /\.send-btn,\s*\.send-btn svg,\s*\.stop-btn svg \{\s*transition: opacity 120ms ease;/);
  assert.match(reduced, /\.stop-btn \{\s*animation: none;/);
  assert.doesNotMatch(css, /transition:[^;}]*visibility/);
});
