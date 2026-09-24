import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("../src/context-model.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the scope's model panel writes through the same endpoint the composer's default does", () => {
  assert.match(panel, /saveRuntimeConfig\(\s*scope,/);
  assert.match(panel, /\{ inherit: true \}/);
  assert.match(panel, /harnessId,\n\s+modelId: value\.slice\(sep \+ 1\)/);
  assert.doesNotMatch(panel, /applyRuntimeOptions/);
});

test("the panel offers inheriting the org default and names what is serving now", () => {
  assert.match(panel, /changeDefault: \(\) => choose\(scopeId, INHERIT\)/);
  assert.match(panel, /no longer offered/);
});

test("context settings reuse the composer picker and disable it while saving", () => {
  assert.match(panel, /createModelPicker<void>/);
  assert.match(panel, /picker.render\(undefined, option, contextModelState.saving\)/);
  assert.doesNotMatch(panel, /fieldSelect/);
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

test("an in-flight pick wins the saving re-render — no snap-back while the save runs", () => {
  assert.match(panel, /pending: null as string \| null/);
  assert.match(panel, /contextModelState\.pending = value/);
  assert.match(panel, /contextModelState\.saving = false;\n\s+contextModelState\.pending = null;/);
});

test("context effort and Fast use the shared harness and model capabilities", () => {
  assert.match(panel, /return effortLevelsForHarness\(harnessId\)/);
  assert.match(panel, /harnessSupportsFastMode\(harnessId\)/);
  assert.match(panel, /modelSupportsFastMode\(scope, value.slice\(sep \+ 1\)\)/);
});

test("no effort is ever sent for a harness that doesn't support it", () => {
  assert.match(panel, /if \(!harnessSupportsEffort\(harnessId\)\) return \[\];/);
});

test("the model card omits explanatory and success prose", () => {
  assert.doesNotMatch(
    panel,
    /The model every conversation|Following the org default|Pinned for this project|Saved\. New conversations/,
  );
});
