import assert from "node:assert/strict";
import test from "node:test";
import { emptySelection, pruneSelection, selectionClick } from "../src/session-select.ts";

const order = ["a", "b", "c", "d", "e"];

test("plain click sets the anchor and clears selection", () => {
  const s = selectionClick(emptySelection(), order, "b", { shift: false, toggle: false });
  assert.deepEqual([...s.ids], []);
  assert.equal(s.anchor, "b");
});

test("shift-click selects the range from the anchor", () => {
  let s = selectionClick(emptySelection(), order, "b", { shift: false, toggle: false });
  s = selectionClick(s, order, "d", { shift: true, toggle: false });
  assert.deepEqual([...s.ids].sort(), ["b", "c", "d"]);
  assert.equal(s.anchor, "b");
});

test("a second shift-click replaces the previous range", () => {
  let s = selectionClick(emptySelection(), order, "b", { shift: false, toggle: false });
  s = selectionClick(s, order, "e", { shift: true, toggle: false });
  s = selectionClick(s, order, "c", { shift: true, toggle: false });
  assert.deepEqual([...s.ids].sort(), ["b", "c"]);
});

test("shift range works upward from the anchor", () => {
  let s = selectionClick(emptySelection(), order, "d", { shift: false, toggle: false });
  s = selectionClick(s, order, "a", { shift: true, toggle: false });
  assert.deepEqual([...s.ids].sort(), ["a", "b", "c", "d"]);
});

test("cmd-click toggles a row and moves the anchor", () => {
  let s = selectionClick(emptySelection(), order, "a", { shift: false, toggle: true });
  s = selectionClick(s, order, "d", { shift: false, toggle: true });
  assert.deepEqual([...s.ids].sort(), ["a", "d"]);
  assert.equal(s.anchor, "d");
  s = selectionClick(s, order, "a", { shift: false, toggle: true });
  assert.deepEqual([...s.ids], ["d"]);
});

test("shift after cmd keeps the cmd-added rows (Finder behavior)", () => {
  let s = selectionClick(emptySelection(), order, "a", { shift: false, toggle: true });
  s = selectionClick(s, order, "c", { shift: false, toggle: true });
  s = selectionClick(s, order, "e", { shift: true, toggle: false });
  assert.deepEqual([...s.ids].sort(), ["a", "c", "d", "e"]);
  s = selectionClick(s, order, "d", { shift: true, toggle: false });
  assert.deepEqual([...s.ids].sort(), ["a", "c", "d"]);
});

test("shift-click with no anchor selects only the clicked row", () => {
  const s = selectionClick(emptySelection(), order, "c", { shift: true, toggle: false });
  assert.deepEqual([...s.ids], ["c"]);
  assert.equal(s.anchor, "c");
});

test("prune drops rows no longer visible", () => {
  let s = selectionClick(emptySelection(), order, "a", { shift: false, toggle: true });
  s = selectionClick(s, order, "b", { shift: false, toggle: true });
  const pruned = pruneSelection(s, new Set(["b", "c"]));
  assert.deepEqual([...pruned.ids], ["b"]);
});
