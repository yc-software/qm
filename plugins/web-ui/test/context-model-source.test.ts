import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("../src/context-model.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the scope's model panel writes through the same endpoint the composer's default does", () => {
  assert.match(panel, /updateRuntimeConfig\(\s*scope,/);
  assert.match(panel, /\{ inherit: true \}/);
  assert.match(panel, /harnessId,\n\s+modelId: value\.slice\(sep \+ 1\)/);
  assert.doesNotMatch(panel, /applyRuntimeOptions/);
});

test("the panel offers inheriting the org default and names what is serving now", () => {
  assert.match(panel, /Org default \(\$\{labelForRuntime\(config, config\.orgDefault\)\}\)/);
  assert.match(panel, /!options\.some\(\(o\) => o\.value === selected\)/);
  assert.match(panel, /no longer offered/);
  assert.match(panel, /Saved — new conversations here run on/);
  assert.match(panel, /The pinned Slack header \(when enabled below\) names this model\./);
});

test("the panel is labelled, focus-keyed, and disabled while saving", () => {
  assert.match(panel, /ariaLabel: "Default model for this project"/);
  assert.match(panel, /focusKey: "context-model"/);
  assert.match(panel, /disabled: contextModelState\.saving/);
  assert.match(panel, /aria-live="polite"/);
});

test("every context loads and resets its model setting with the page", () => {
  assert.match(contexts, /loadContextModel\(contextsState\.selected, drawContexts\)/);
  assert.match(contexts, /resetContextModel\(\)/);
  assert.match(contexts, /<aside class="context-settings"[^]*?contextModelSection\(c\.scopeId\)/);
});

test("model panel styles use the shell theme contract", () => {
  const block = css.slice(css.indexOf(".context-model {"), css.indexOf("\n.ambient-policy {"));
  assert.match(block, /color: var\(--muted-foreground\)/);
  assert.match(block, /color: var\(--destructive/);
  assert.doesNotMatch(block, /#[0-9a-f]{6}(?![^)]*\))/i);
});

test("the model dropdown marks the pinned option selected so the first paint is honest", () => {
  assert.match(panel, /\?selected=\$\{selected === INHERIT\}/);
  assert.match(panel, /\?selected=\$\{o\.value === selected\}/);
  assert.match(panel, /option value=\$\{selected\} selected/);
});

test("an in-flight pick wins the saving re-render — no snap-back while the save runs", () => {
  assert.match(panel, /pending: null as string \| null/);
  assert.match(panel, /contextModelState\.pending = value/);
  assert.match(panel, /const selected = contextModelState\.pending \?\? selectedValue\(config\)/);
  // pending is cleared with saving, in the same guarded finally
  assert.match(panel, /contextModelState\.saving = false;\n\s+contextModelState\.pending = null;/);
});

test("a pinned model offers a default effort level on the panel", () => {
  assert.match(panel, /harnessSupportsEffort\(pinnedHarness\)/);
  assert.match(panel, /ariaLabel: "Default effort level for this project"/);
  assert.match(panel, /focusKey: "context-effort"/);
  // effort choices are filtered to what the pinned harness accepts
  assert.match(panel, /if \(value === "ultracode"\) return harnessId === "pi"/);
  assert.match(panel, /if \(value === "max"\) return harnessId !== "codex"/);
  // switching models carries a still-valid effort, drops an invalid one
  assert.match(panel, /effortLevelsFor\(nextHarness\)\.some\(\(o\) => o\.value === effort\) \? effort : undefined/);
  // the effort styles exist
  assert.ok(css.includes(".context-model-effort {"));
});
