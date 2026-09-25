import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const browse = readFileSync(new URL("../src/browse.ts", import.meta.url), "utf8");

test("the browse palette is a 2-column grid over every destination, escape-dismissable", () => {
  assert.match(browse, /const BROWSE_COLUMNS = 2;/);
  assert.match(
    readFileSync(new URL("../src/shell.css", import.meta.url), "utf8"),
    /\.browse-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(browse, /e\.key === "Escape"[\s\S]{0,80}closeBrowse\(\)/);
  for (const label of ["Projects", "Files", "Crons", "Keychain", "Apps", "Memory", "Skills", "Admin"]) {
    assert.match(browse, new RegExp(`"${label}"`));
  }
});

test("every tile is a real link, so middle-click and open-in-new-tab still work", () => {
  assert.match(browse, /<a\s+class="browse-tile[\s\S]{0,400}href=\$\{d\.href\}/);
  assert.match(browse, /if \(!isPlainLeftClick\(e\)\) return;/);
});
