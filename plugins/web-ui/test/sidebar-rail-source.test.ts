import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("collapsed sidebar is an in-flow rail, not a floating button", () => {
  assert.doesNotMatch(shell, /sidebar-peek-toggle/);
  assert.doesNotMatch(css, /sidebar-peek-toggle/);
  assert.match(css, /--rail-w: 50px/);
  assert.match(css, /\.layout\.sidebar-closed \.sidebar \{\s*width: var\(--rail-w\);\s*\}/);
  assert.match(css, /\.sidebar \{[^}]*transition: width 0\.18s ease;/);
  assert.match(css, /body\.resizing-sidebar \.sidebar \{\s*transition: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar \{\s*transition: none;/);
});

test("hidden sidebar innards are out of the focus order and keep their layout while clipped", () => {
  assert.match(css, /\.sidebar > :not\(\.brand\) \{\s*min-width: calc\(var\(--sidebar-w\) - 16px\);/);
  assert.match(
    css,
    /\.layout\.sidebar-closed \.sidebar > :not\(\.brand\):not\(#sidebar-top\),\s*\.layout\.sidebar-closed \.brand-lockup \{[^}]*opacity: 0;\s*visibility: hidden;\s*\}/,
  );
  assert.doesNotMatch(css, /transition:[^;}]*visibility/);
  assert.doesNotMatch(shell, /sidebar\.inert/);
});

test("the collapsed rail keeps icon-only navigation instead of going empty", () => {
  assert.match(
    css,
    /\.layout\.sidebar-closed #sidebar-top \{\s*min-width: 0;[^}]*min-height: 0;\s*overflow-y: auto;\s*\}/,
  );
  assert.match(
    css,
    /\.layout\.sidebar-closed #sidebar-top \.new-chat span,\s*\.layout\.sidebar-closed #sidebar-top \.navrow span,\s*\.layout\.sidebar-closed #sidebar-top \.nav-section-toggle,\s*\.layout\.sidebar-closed #sidebar-top \.section-label \{\s*display: none;/,
  );
  assert.match(css, /\.layout\.sidebar-closed #sidebar-top \.nav-group\.collapsed \{[^}]*grid-template-rows: 1fr;/);
  assert.match(
    css,
    /\.layout\.sidebar-closed #sidebar-top \.new-chat,\s*\.layout\.sidebar-closed #sidebar-top \.navrow \{\s*justify-content: center;/,
  );
  // Icon-only rows need tooltips to carry their labels.
  assert.match(shell, /class="navrow[^`]*title=\$\{label\}/);
});

test("narrow viewports keep the rail in flow and size it for touch + safe area", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 860px)"));
  assert.match(narrow, /--rail-w: calc\(max\(8px, env\(safe-area-inset-left\)\) \+ 52px\)/);
  assert.match(narrow, /\.layout\.sidebar-closed \.sidebar \{\s*position: static;\s*box-shadow: none;/);
  assert.match(narrow, /\.sidebar \{[^}]*transition: none;/);
});

test("per-view clearance hacks for the old floating button are gone", () => {
  assert.doesNotMatch(css, /sidebar-closed \.kc-hero-copy/);
  assert.doesNotMatch(css, /peek-clearance/);
});
