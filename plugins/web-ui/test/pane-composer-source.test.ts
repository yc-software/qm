import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("pane composers default to the full-width input above a separate toolbar", () => {
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

test("only short split panes put the textarea and toolbar on the same grid row", () => {
  assert.match(css, /\.split-pane-content \{\s*container: split-pane \/ size;/);
  const short = css.slice(css.indexOf("@container split-pane (max-height: 480px)"));
  assert.match(short, /\.composer-wrap \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(short, /\.composer-wrap > \* \{\s*grid-column: 1 \/ -1;/);
  assert.match(short, /\.composer-input \{[^}]*grid-column: 1;[^}]*min-height: 34px;[^}]*max-height: 120px;/);
  assert.match(short, /\.composer-toolbar \{[^}]*grid-column: 2;[^}]*flex-wrap: nowrap;/);
  assert.doesNotMatch(short, /\.composer-input \{[^}]*(?<!-)height:/);
  assert.match(short, /\.composer-input::placeholder \{\s*white-space: nowrap;/);
});

test("narrow short panes hide runtime labels, not the accessible picker", () => {
  const narrow = css.slice(css.indexOf("@container split-pane (max-height: 480px) and (max-width: 470px)"));
  assert.match(narrow, /\.loadout-button \.menu-label,/);
  assert.match(narrow, /\.loadout-button \.menu-suffix \{\s*display: none;/);
  assert.match(narrow, /\.loadout-button \{[^}]*width: 34px;/);
  assert.doesNotMatch(narrow, /\.loadout-(?:button|control) \{[^}]*display: none;/);
  assert.match(composer, /aria-label=\$\{`Model:/);
});

test("short panes preserve the account action with a named icon-only button", () => {
  const account = composer.match(/<button\s+type="button"\s+class="btn composer-account"[^]*?<\/button>/)?.[0] ?? "";
  assert.match(account, /aria-label=\$\{appState\.me\?\.individualModelAuth \? "My account" : "Company access"\}/);
  assert.match(account, /@click=\$\{\(\) => switchView\("settings"\)\}/);
  assert.match(account, /class="composer-account-icon" aria-hidden="true"/);
  assert.match(css, /^\.composer-account-icon \{\s*display: none;/m);
  const short = css.slice(css.indexOf("@container split-pane (max-height: 480px)"));
  assert.match(short, /\.composer-account-label \{\s*display: none;/);
  assert.match(short, /\.composer-account-icon \{\s*display: inline-flex;/);
  assert.doesNotMatch(short, /\.composer-account \{[^}]*display: none;/);
});

test("the smallest short panes leave text space even with stop and account controls", () => {
  const minimum = css.slice(css.indexOf("@container split-pane (max-height: 480px) and (max-width: 300px)"));
  assert.match(minimum, /\.composer-toolbar \.stop-btn,/);
  assert.match(minimum, /\.composer-toolbar \.composer-account \{\s*width: 28px;\s*height: 28px;\s*min-height: 28px;/);
  assert.match(minimum, /\.composer-attach \{\s*transform: none;/);
});
