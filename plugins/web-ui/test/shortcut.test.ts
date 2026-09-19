import assert from "node:assert/strict";
import test from "node:test";
import { matchesPrimaryShortcut } from "../src/shortcut.ts";

function event(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

test("primary shortcuts match command on macOS and control elsewhere", () => {
  assert.equal(matchesPrimaryShortcut(event("N", { metaKey: true }), "n", true), true);
  assert.equal(matchesPrimaryShortcut(event("n", { ctrlKey: true }), "n", false), true);
  assert.equal(matchesPrimaryShortcut(event("k", { metaKey: true }), "n", true), false);
  assert.equal(matchesPrimaryShortcut(event("n"), "n", true), false);
});

test("primary shortcuts reject additional modifiers", () => {
  for (const modifiers of [
    { metaKey: true, ctrlKey: true },
    { metaKey: true, altKey: true },
    { metaKey: true, shiftKey: true },
  ]) {
    assert.equal(matchesPrimaryShortcut(event("n", modifiers), "n", true), false);
  }
  for (const modifiers of [
    { ctrlKey: true, metaKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true },
  ]) {
    assert.equal(matchesPrimaryShortcut(event("n", modifiers), "n", false), false);
  }
});
