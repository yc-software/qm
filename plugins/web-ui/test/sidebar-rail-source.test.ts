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
  assert.match(shell, /sidebar\.inert = hiddenDrawer/);
  assert.match(shell, /if \(hiddenDrawer\) sidebar\.setAttribute\("aria-hidden", "true"\)/);
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

test("narrow viewports use an off-canvas drawer and a safe-area-aware touch launcher", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 860px)"));
  assert.match(shell, /class="icon-btn subtle sidebar-toggle mobile-sidebar-toggle"/);
  assert.match(
    narrow,
    /\.layout\.sidebar-closed \.sidebar \{\s*width: min\(var\(--sidebar-w\), calc\(100vw - 48px\)\);\s*transform: translateX\(-100%\);/,
  );
  assert.match(
    narrow,
    /\.mobile-sidebar-toggle \{[^}]*left: max\(10px, env\(safe-area-inset-left\)\);[^}]*width: 44px;[^}]*height: 44px;/,
  );
  assert.match(narrow, /\.pane \{\s*padding: calc\(70px \+ var\(--surface-safe-top\)\)/);
  assert.match(
    narrow,
    /\.main > \.custom-chat \.chat-topbar \{[^}]*max\(64px, calc\(env\(safe-area-inset-left\) \+ 54px\)\)/,
  );
  assert.match(
    narrow,
    /\.main > \.split-canvas > \.split-dock \{\s*padding: calc\(64px \+ var\(--surface-safe-top\)\) max\(5px, env\(safe-area-inset-right\)\)\s*max\(5px, env\(safe-area-inset-bottom\)\) max\(5px, env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    narrow,
    /\.resource-pane \{[^}]*padding-right: max\(24px, env\(safe-area-inset-right\)\);[^}]*padding-left: max\(24px, env\(safe-area-inset-left\)\)/,
  );
  assert.match(shell, /focusedLauncher[\s\S]*\.sidebar-collapse-toggle/);
});

test("per-view clearance hacks for the old floating button are gone", () => {
  assert.doesNotMatch(css, /sidebar-closed \.kc-hero-copy/);
  assert.doesNotMatch(css, /peek-clearance/);
});
