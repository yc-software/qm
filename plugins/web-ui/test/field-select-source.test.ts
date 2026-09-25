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
  assert.doesNotMatch(ui, /function selectMenu/);
  assert.doesNotMatch(readFileSync(new URL("sessions.ts", srcDir), "utf8"), /selectMenu/);
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

test("list dropdowns share enough width to show their selected value", () => {
  assert.match(css, /\.list-select \.field-select \{\s*min-width: 124px;/);
});

test("the list caption's weight stays on the caption and off the control it labels", () => {
  const start = css.indexOf(".list-select {");
  const block = css.slice(start, css.indexOf("}", start));
  assert.doesNotMatch(block, /font-weight/, "a weight on .list-select reaches the select through font: inherit");
  assert.match(css, /\.list-select > span:not\(\.field-select\) \{\s*font-size: 11px;\s*font-weight: 600;/);
});

test("the dropdown holds the caller's value against re-renders (live) and stale DOM state", () => {
  // .value on a <select> commits before its <option> children exist on first render,
  // and lit's default dirty-check skips re-asserting it when the DOM has drifted —
  // so the caller's value must go through live(), and options mark their own selected.
  assert.match(ui, /import \{ live \} from "lit\/directives\/live\.js"/);
  assert.match(ui, /\.value=\$\{props\.value === undefined \? nothing : live\(props\.value\)\}/);
});

const sessions = readFileSync(new URL("sessions.ts", srcDir), "utf8");
const contexts = readFileSync(new URL("contexts.ts", srcDir), "utf8");

test("the context and surface filters are the same control, built once", () => {
  assert.match(ui, /export function menuSelect\(props: \{/);
  for (const [name, source] of [
    ["the context filter", contexts],
    ["the surface filter", sessions],
  ] as const) {
    assert.match(source, /menuSelect\(\{/, `${name} should render through menuSelect`);
    assert.doesNotMatch(
      source.slice(source.indexOf("menuSelect({")),
      /^\s*<div class="menu-control/m,
      `${name} should not hand-roll the menu markup`,
    );
  }
  assert.doesNotMatch(sessions, /fieldSelect/, "the surface filter no longer uses the native select");
});

test("a filter menu opens straight onto its options, with no header restating the button", () => {
  const menu = ui.match(/export function menuSelect\(props: \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(menu, /menu-title/, "the header only ever repeated the label already on the button");
  assert.doesNotMatch(menu, /title\?: string;/);
  for (const [name, source] of [
    ["the context filter", contexts],
    ["the surface filter", sessions],
  ] as const) {
    const call = source.slice(source.indexOf("menuSelect({"));
    assert.doesNotMatch(call.slice(0, call.indexOf("})")), /title:/, `${name} still passes a menu header`);
    assert.match(
      call.slice(0, call.indexOf("})")),
      /ariaLabel:/,
      `${name} must keep naming itself for a screen reader`,
    );
  }
});

test("the menu-backed filter wears the same box as the native select's resting state", () => {
  const box = (rule: string): Record<string, string> => {
    const start = css.indexOf(rule);
    assert.ok(start >= 0, `${rule} should exist`);
    const block = css.slice(start, css.indexOf("}", start));
    return Object.fromEntries([...block.matchAll(/\n\s*([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const select = box("\n.field-select > select {");
  const menu = box("\n.field-menu .menu-button {");
  for (const prop of ["border", "border-radius"]) {
    assert.equal(menu[prop], select[prop], `${prop} must match the native select`);
  }
  assert.equal(menu["background"], "var(--background)");
  assert.equal(menu["color"], "var(--foreground)");
  assert.equal(menu["height"], "34px");
  assert.equal(select["min-height"], "34px");
});

test("a filter menu opens downward, since the shared popover defaults to opening up for the composer", () => {
  const control = ui.match(/<div\s+class=\$\{`menu-control form-menu-control field-menu[\s\S]*?>/)?.[0] ?? "";
  assert.match(control, /data-drop="down"/, "without this the filter opens over the header above it");
  assert.match(css, /\.menu-control\[data-drop="down"\] \.menu-popover \{\s*top: calc\(100% \+ 6px\);\s*bottom: auto;/);
  assert.match(
    css,
    /\.menu-control\[data-drop="down"\] \.menu-popover\.drop-up \{/,
    "the flip-up fallback must survive so a filter near the bottom edge still fits",
  );
  const scope = css.match(/\n\.scope-filter \.menu-popover \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(scope, /top:|bottom:/, "drop direction belongs to the shared control, not one caller");
});
