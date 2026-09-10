import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

const sizeAside = inbox.match(/function sizeAside\(host: HTMLElement\): void \{[\s\S]*?\n\}/)?.[0] ?? "";

const MIN = 320;
const MAX = 1100;
const PAD_TOP = 28;
const PAD_BOTTOM = 40;

function heightFor(viewport: number): number {
  return Math.min(MAX, Math.max(MIN, viewport - PAD_TOP - PAD_BOTTOM));
}

test("the assistant ends at the pane's content box, so its own height cannot scroll the page", () => {
  assert.equal(heightFor(900), 832);
  assert.equal(heightFor(700), 632);
  assert.equal(heightFor(500), 432);
});

test("a very tall window stops growing the assistant at its ceiling", () => {
  assert.equal(heightFor(1300), MAX);
  assert.equal(heightFor(4000), MAX);
});

test("a very short window overrides the fit: the assistant keeps its floor and overflows into page scroll", () => {
  assert.equal(heightFor(340), MIN);
  assert.equal(heightFor(300), MIN);
  assert.ok(
    MIN > 300 - PAD_TOP - PAD_BOTTOM,
    "the floor must exceed what a short viewport offers, or nothing overflows",
  );
});

test("sizeAside clamps on both ends rather than only flooring", () => {
  assert.match(sizeAside, /Math\.min\(ASIDE_MAX_HEIGHT, Math\.max\(ASIDE_MIN_HEIGHT, available\)\)/);
  assert.match(sizeAside, /host\.clientHeight - padTop - padBottom/);
  assert.match(inbox, new RegExp(`const ASIDE_MIN_HEIGHT = ${MIN};`));
  assert.match(inbox, new RegExp(`const ASIDE_MAX_HEIGHT = ${MAX};`));
});

test("the height is recomputed when the pane resizes, not only when it renders", () => {
  const observer = inbox.match(/function observeAsideSize\(host: HTMLElement\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(observer, /new ResizeObserver\(/);
  assert.match(observer, /sizeAside\(host\)/);
  assert.match(observer, /\.observe\(host\)/);
  assert.match(inbox, /appState\.mainEl\.replaceChildren\(host\);\s*observeAsideSize\(host\);/);
});

test("recreating the page host replaces its observer instead of stacking another one", () => {
  const observer = inbox.match(/function observeAsideSize\(host: HTMLElement\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(observer, /asideObserver\?\.disconnect\(\);/);
  assert.match(inbox, /let asideObserver: ResizeObserver \| null = null;/);
});

test("writing the same height twice is skipped, so the observer cannot feed itself", () => {
  assert.match(sizeAside, /if \(host\.style\.getPropertyValue\("--inbox-aside-height"\) === next\) return;/);
});

test("the pre-JS fallback carries the same bounds as the measured height", () => {
  assert.match(css, /height: var\(--inbox-aside-height, clamp\(320px, 70vh, 1100px\)\);/);
});
