import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("scope-default buttons render only after the model selection is toggled off the default", () => {
  assert.match(composer, /const modelToggled = !runtimePending && selectedModel\.value !== defaultModelValue\(\)/);
  assert.match(composer, /\$\{\s*modelToggled\s*\? html`[\s\S]{0,800}?\$\{t\("Make default"\)\}\s*<\/button>/);
  assert.match(composer, /\$\{\s*modelToggled && activeRuntimeConfig\?\.scopeOverride/);
});

test("composer-right keeps its control order: make default, use org default, model, harness, send", () => {
  const right = composer.slice(composer.indexOf('class="composer-right"'));
  const makeDefault = right.indexOf("Make default");
  const orgDefault = right.indexOf("Use org default");
  const model = right.indexOf('kind: "model"');
  const harness = right.indexOf('kind: "harness"');
  const send = right.indexOf("sendControls(agent)");
  for (const [name, at] of [
    ["Make default", makeDefault],
    ["Use org default", orgDefault],
    ["model picker", model],
    ["harness picker", harness],
    ["send controls", send],
  ] as const) {
    assert.ok(at >= 0, `${name} missing from composer-right`);
  }
  assert.ok(makeDefault < orgDefault, "Make default should precede Use org default");
  assert.ok(orgDefault < model, "Use org default should precede the model picker");
  assert.ok(model < harness, "the model picker should precede the harness picker");
  assert.ok(harness < send, "the harness picker should precede the send controls");
});
