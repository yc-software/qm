import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");

const indicator = css.match(/\.sidebar \.list::before \{[^}]*\}/)?.[0] ?? "";

test("the active-row indicator is an absolutely positioned pseudo inside the positioned scroll container", () => {
  assert.match(css, /\.sidebar \.list \{\s*position: relative;/);
  assert.match(indicator, /position: absolute;/);
  assert.match(indicator, /pointer-events: none;/);
  assert.match(indicator, /transform: translateY\(var\(--active-y, 0px\)\);/);
  assert.match(indicator, /opacity: var\(--active-on, 0\);/);
  assert.match(
    indicator,
    /background: var\(--active-color, color-mix\(in srgb, var\(--foreground\) 70%, transparent\)\);/,
  );
});

test("the indicator only transitions transform and opacity, and reduced motion drops the slide", () => {
  const transition = indicator.match(/transition:([^;]*);/)?.[1] ?? "";
  assert.match(transition, /^\s*transform 240ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\),\s*opacity 160ms ease\s*$/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar \.list::before \{\s*transition: opacity 160ms ease;\s*\}\s*\}/,
  );
});

test("renderList measures the active row inside a rAF after the sidebar commit and fades in without sliding from the top", () => {
  assert.match(sessions, /notifySessionsChanged\(\);\s*placeActiveIndicator\(\);\s*\}/);
  const fn = sessions.match(/function placeActiveIndicator\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  const raf = fn.indexOf("requestAnimationFrame");
  const measure = fn.indexOf("getBoundingClientRect");
  assert.ok(raf >= 0 && measure > raf, "layout reads must happen inside the rAF");
  assert.match(
    fn,
    /\.find\(\(r\) => !r\.closest\("\[hidden\]"\)\)/,
    "a collapsed project's active row must not place the bar",
  );
  assert.match(fn, /el\.scrollTop/, "the offset must be scroll-independent");
  assert.match(fn, /getPropertyValue\("--session-color"\)/);
  assert.match(
    fn,
    /if \(el\.style\.getPropertyValue\("--active-on"\) === "1"\) return;\s*requestAnimationFrame\(\(\) => el\.style\.setProperty\("--active-on", "1"\)\);/,
  );
});
