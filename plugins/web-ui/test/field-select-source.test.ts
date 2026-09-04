import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import test from "node:test";

const srcDir = new URL("../src/", import.meta.url);
const ui = readFileSync(new URL("ui.ts", srcDir), "utf8");
const css = readFileSync(new URL("shell.css", srcDir), "utf8");

test("the shell has exactly one dropdown, and it is a real select", () => {
  const offenders = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readFileSync(new URL(f, srcDir), "utf8").includes("<select"));
  assert.deepEqual(offenders, ["ui.ts"], "every dropdown goes through fieldSelect()");
  assert.match(ui, /<select/);
  assert.match(ui, /icon\(ChevronDown, 16\)/);
});

test("the dropdown keeps the accessible name, focus key and disabled state its callers pass", () => {
  for (const attr of [
    /id=\$\{props\.id \?\? nothing\}/,
    /aria-label=\$\{props\.ariaLabel \?\? nothing\}/,
    /aria-describedby=\$\{props\.describedBy \?\? nothing\}/,
    /data-focus-key=\$\{props\.focusKey \?\? nothing\}/,
    /\?disabled=\$\{props\.disabled \?\? false\}/,
  ])
    assert.match(ui, attr);
});

test("the chevron is inset from the edge, not pinned to it", () => {
  const block = css.slice(css.indexOf(".field-select {"), css.indexOf(".field-select.compact > select"));
  assert.match(block, /appearance: none/);
  assert.match(block, /padding: 0 36px 0 10px/);
  assert.match(block, /right: 12px/);
  assert.match(block, /pointer-events: none/);
});

test("no page keeps its own select chrome now that one rule owns it", () => {
  for (const dead of [".list-select select {", ".deploy-sort select {", ".ambient-enabled-select {\n  align-self"])
    assert.ok(!css.includes(dead) || dead.includes("align-self"), `${dead} should be gone`);
  assert.doesNotMatch(css, /\.list-select select \{/);
  assert.doesNotMatch(css, /\.deploy-sort select \{/);
});

test("the dropdown holds the caller's value against re-renders (live) and stale DOM state", () => {
  // .value on a <select> commits before its <option> children exist on first render,
  // and lit's default dirty-check skips re-asserting it when the DOM has drifted —
  // so the caller's value must go through live(), and options mark their own selected.
  assert.match(ui, /import \{ live \} from "lit\/directives\/live\.js"/);
  assert.match(ui, /\.value=\$\{props\.value === undefined \? nothing : live\(props\.value\)\}/);
});
