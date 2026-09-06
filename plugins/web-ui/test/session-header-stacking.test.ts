import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the main session header paints above its composited transcript scroller", () => {
  const block = css.match(/\.chat-topbar \{[^}]*\}/)?.[0] ?? "";
  assert.match(block, /position: relative;/, "the header must establish a positioned stacking layer");
  assert.match(block, /z-index: 1;/, "the header must paint above the transcript scroller");
});
