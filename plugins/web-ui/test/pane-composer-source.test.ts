import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("pane composers keep the full-width input above a separate toolbar", () => {
  assert.doesNotMatch(css, /\.embed-layout/, "panes are elements now, not framed documents");
  const wrap = css.match(/^\.composer-wrap \{[^}]*\}/m)?.[0] ?? "";
  assert.doesNotMatch(wrap, /display: flex;/);
  assert.match(css, /^\.composer-input \{[^}]*width: 100%;[^}]*min-height: 48px;/m);
  assert.match(css, /^\.composer-toolbar \{[^}]*display: flex;[^}]*justify-content: space-between;/m);
  assert.doesNotMatch(css, /\[data-density[^\]]*\] \.composer-(?:wrap|input|toolbar)\s*\{/);
  assert.match(composer, /Math\.max\(ctx\.pane \? 0 : 48, content\)/);
});

test("a pane's composer inherits the shared transcript column and surface gutters", () => {
  const block = css.match(/^\.composer-wrap \{[^}]*\}/m)?.[0] ?? "";
  assert.match(block, /width: min\(var\(--content-w\), calc\(100% - 32px\)\);/);
  assert.match(block, /margin: 0 auto max\(18px, calc\(10px \+ env\(safe-area-inset-bottom\)\)\);/);
  assert.match(css, /@container chat \(max-width: 860px\) \{[^]*?\.composer-wrap \{[^}]*width: auto;/);
});

test("phone touch layout cannot inflate a pane's composer controls", () => {
  assert.match(
    css,
    /\[data-density\] \.composer-toolbar \.icon-btn,\s*\[data-density\] \.composer-toolbar \.menu-button,\s*\[data-density\] \.composer-toolbar \.send-btn \{\s*width: 34px;\s*height: 34px;\s*min-height: 34px;/,
  );
  assert.doesNotMatch(css, /\[data-density[^\]]*\] \.composer-(?:left|right)[^{]*\{/);
});

test("pane settings control is visible without hover", () => {
  assert.doesNotMatch(css, /\.composer-wrap:hover \.settings-control/);
  const block = css.match(/\.settings-control \.menu-button \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(block, /opacity: 0;/);
});
