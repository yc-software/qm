import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const settings = composer.slice(
  composer.indexOf("function settingsControl("),
  composer.indexOf("function menuControl("),
);
const fast = settings.slice(settings.indexOf("fastAvailable\n"));

test("compact Fast mode uses a stateful icon-and-label chip without a trailing checkmark", () => {
  assert.match(fast, /class="settings-chip settings-fast-toggle \$\{fastOn \? "active" : ""\}"/);
  assert.match(fast, /role="menuitemcheckbox"/);
  assert.match(fast, /aria-checked=\$\{fastOn \? "true" : "false"\}/);
  assert.match(fast, /@click=\$\{\(\) => toggleFastMode\(agent\)\}/);
  assert.match(fast, /icon\(Zap, 15\)/);
  assert.match(fast, /<span>Fast mode<\/span>/);
  assert.doesNotMatch(fast, /icon\(Check/);
  assert.doesNotMatch(fast, /menu-option-copy|menu-option-label/);
});

test("the Fast mode icon and label stay aligned and the active icon is filled", () => {
  const toggle = css.match(/\.settings-fast-toggle \{[^}]*\}/)?.[0] ?? "";
  assert.match(toggle, /display: inline-flex;/);
  assert.match(toggle, /align-items: center;/);
  assert.match(toggle, /white-space: nowrap;/);
  assert.match(css, /\.settings-fast-toggle\.active \.icon \{\s*fill: currentColor;\s*\}/);
});
