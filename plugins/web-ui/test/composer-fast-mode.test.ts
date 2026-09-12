import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const fast = composer.slice(
  composer.indexOf('class="loadout-setting"'),
  composer.indexOf('<div class="loadout-foot">'),
);

test("Fast is a stateful toggle row without a trailing checkmark", () => {
  assert.match(fast, /class="loadout-setting"/);
  assert.match(fast, /role="menuitemcheckbox"/);
  assert.match(fast, /aria-checked=\$\{fastOn \? "true" : "false"\}/);
  assert.match(fast, /@click=\$\{\(\) => toggleFastMode\(agent\)\}/);
  assert.match(fast, /class="loadout-toggle \$\{fastOn \? "on" : ""\}"/);
  assert.doesNotMatch(fast.slice(0, fast.indexOf("</button>")), /icon\(Check/);
});

test("the Fast toggle names itself and hides its decorative track", () => {
  assert.match(fast, /aria-label="Fast"/);
  assert.match(fast, /aria-hidden="true"/);
  assert.match(fast, /class="loadout-shortcut">⌘⇧E/);
});

test("the toggle track and knob carry their own state styling", () => {
  assert.match(css, /\.loadout-toggle \{[^}]*\}/);
  assert.match(css, /\.loadout-toggle\.on \{[^}]*\}/);
  assert.match(css, /\.loadout-knob \{[^}]*\}/);
});
