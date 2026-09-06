import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const mobileButton = css.indexOf("\n.mobile-menu-btn {");
assert.ok(mobileButton >= 0, "the mobile menu button has a desktop visibility rule");
const mobileShell = css.indexOf("@media (max-width: 860px) {", mobileButton);
assert.ok(mobileShell > mobileButton, "the phone shell media query follows the mobile menu button rule");

test("collapsed sidebar is an in-flow rail, not a floating button", () => {
  assert.doesNotMatch(shell, /sidebar-peek-toggle/);
  assert.doesNotMatch(css, /sidebar-peek-toggle/);
  assert.match(css, /--rail-w: 50px/);
  assert.match(css, /\.layout\.sidebar-closed \.sidebar \{\s*width: var\(--rail-w\);\s*padding-right: 8px;\s*\}/);
  assert.match(css, /\.sidebar \{[^}]*transition: width 0\.18s ease;/);
  assert.match(css, /body\.resizing-sidebar \.sidebar \{\s*transition: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar \{\s*transition: none;/);
});

test("hidden sidebar innards are out of the focus order and keep their layout while clipped", () => {
  assert.match(css, /\.sidebar > :not\(\.brand\) \{\s*min-width: calc\(var\(--sidebar-w\) - 16px\);/);
  assert.match(
    css,
    /\.layout\.sidebar-closed \.sidebar > :not\(\.brand\):not\(#sidebar-top\):not\(#sidebar-footer\),\s*\.layout\.sidebar-closed \.brand-lockup \{[^}]*opacity: 0;\s*visibility: hidden;\s*\}/,
  );

  assert.doesNotMatch(css.slice(0, mobileShell), /transition:[^;}]*visibility/);
  assert.doesNotMatch(shell, /sidebar\.inert/);
});

test("the collapsed rail keeps icon-only navigation instead of going empty", () => {
  assert.match(
    css,
    /\.layout\.sidebar-closed #sidebar-top \{\s*min-width: 0;[^}]*min-height: 0;\s*overflow-y: auto;\s*\}/,
  );
  assert.match(
    css,
    /\.layout\.sidebar-closed #sidebar-top \.navrow span,\s*\.layout\.sidebar-closed #sidebar-top \.section-label \{\s*display: none;/,
  );
  assert.match(css, /\.layout\.sidebar-closed #sidebar-top \.navrow \{\s*justify-content: center;/);

  assert.match(css, /\.layout\.sidebar-closed #sidebar-footer \{\s*min-width: 0;\s*justify-content: center;\s*\}/);
  assert.match(css, /\.layout\.sidebar-closed #sidebar-footer \.user-menu \{\s*display: none;\s*\}/);
  // Icon-only rows need tooltips to carry their labels.
  assert.match(shell, /class="navrow[^`]*\$\{tip\(sidebarOpen \? "" : label\)\}/);
});

test("rail tooltips open beside the icons on first paint and on every toggle", () => {
  assert.match(shell, /data-tip-placement=\$\{sidebarOpen \? "top" : "right"\}/);
  assert.match(shell, /setAttribute\("data-tip-placement", open \? "top" : "right"\)/);
});

test("the collapse toggle's tooltip is pushed in step with the aria-label it mirrors", () => {
  assert.match(shell, /btn\.setAttribute\("aria-label", collapseLabel\);\s*attachTooltip\(btn, collapseLabel\);/);
});

test("phone viewports swap the rail for a slide-over drawer with one floating menu button", () => {
  const mobile = css.slice(mobileShell);

  assert.match(mobile, /\.layout\.sidebar-closed \.sidebar \{\s*transform: translateX\(-106%\);\s*visibility: hidden;/);
  assert.match(mobile, /\.mobile-menu-btn \{\s*display: inline-flex;\s*position: absolute;/);

  assert.match(mobile, /\.chat-topbar \{[^}]*padding-left: calc\(max\(4px, env\(safe-area-inset-left\)\) \+ 48px\);/);

  assert.match(shell, /class="icon-btn sidebar-toggle mobile-menu-btn"[^`]*@click=\$\{toggleSidebar\}/);

  assert.match(css, /\.mobile-menu-btn \{\s*display: none;\s*\}/);
});

test("per-view clearance hacks for the old floating button are gone", () => {
  assert.doesNotMatch(css, /sidebar-closed \.kc-hero-copy/);
  assert.doesNotMatch(css, /peek-clearance/);
});
