import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGridIndex } from "../src/grid-nav.ts";

const COLUMNS = 2;
const COUNT = 8;

test("arrow keys walk a 2-column grid without wrapping off either end", () => {
  assert.equal(nextGridIndex(0, "ArrowRight", COUNT, COLUMNS), 1);
  assert.equal(nextGridIndex(0, "ArrowDown", COUNT, COLUMNS), 2);
  assert.equal(nextGridIndex(3, "ArrowUp", COUNT, COLUMNS), 1);
  assert.equal(nextGridIndex(3, "ArrowLeft", COUNT, COLUMNS), 2);

  assert.equal(nextGridIndex(0, "ArrowLeft", COUNT, COLUMNS), null);
  assert.equal(nextGridIndex(0, "ArrowUp", COUNT, COLUMNS), null);
  assert.equal(nextGridIndex(COUNT - 1, "ArrowRight", COUNT, COLUMNS), null);
  assert.equal(nextGridIndex(COUNT - 1, "ArrowDown", COUNT, COLUMNS), null);
});

test("keys that are not arrows leave the selection alone", () => {
  for (const key of ["Enter", " ", "Escape", "a", "Tab"]) {
    assert.equal(nextGridIndex(2, key, COUNT, COLUMNS), null);
  }
  assert.equal(nextGridIndex(0, "ArrowRight", 0, COLUMNS), null);
});

test("an odd row count keeps the last row reachable and never overshoots it", () => {
  assert.equal(nextGridIndex(5, "ArrowDown", 7, COLUMNS), null);
  assert.equal(nextGridIndex(4, "ArrowDown", 7, COLUMNS), 6);
  assert.equal(nextGridIndex(6, "ArrowRight", 7, COLUMNS), null);
});
