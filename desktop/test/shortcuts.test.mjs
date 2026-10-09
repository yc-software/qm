import assert from "node:assert/strict";
import { test } from "node:test";
import { tabStep } from "../shortcuts.mjs";

const press = (key, modifiers = {}, extra = {}) => ({ type: "keyDown", key, ...modifiers, ...extra });

test("Chrome tab-cycling keys map to next and previous on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(tabStep(press("Tab", { control: true }), platform), 1);
    assert.equal(tabStep(press("Tab", { control: true, shift: true }), platform), -1);
    assert.equal(tabStep(press("PageDown", { control: true }), platform), 1);
    assert.equal(tabStep(press("PageUp", { control: true }), platform), -1);
  }
  assert.equal(tabStep(press("ArrowRight", { meta: true, alt: true }), "darwin"), 1);
  assert.equal(tabStep(press("ArrowLeft", { meta: true, alt: true }), "darwin"), -1);
  assert.equal(tabStep(press("}", { meta: true, shift: true }, { code: "BracketRight" }), "darwin"), 1);
  assert.equal(tabStep(press("{", { meta: true, shift: true }, { code: "BracketLeft" }), "darwin"), -1);
});

test("editing keys, other modifiers, key-up and IME composition are left to the page", () => {
  for (const [input, platform] of [
    [press("Tab", { control: true }, { type: "keyUp" }), "linux"],
    [press("Tab", { control: true }, { isComposing: true }), "linux"],
    [press("ArrowRight", { meta: true, alt: true }), "linux"],
    [press("Tab", { control: true, alt: true }), "linux"],
    [press("Tab"), "darwin"],
  ]) {
    assert.equal(tabStep(input, platform), 0, JSON.stringify(input));
  }
});
