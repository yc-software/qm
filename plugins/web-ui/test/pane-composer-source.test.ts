import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("pane composer collapses to a single line — keyed off the pane, not a whole-document layout class", () => {
  assert.doesNotMatch(css, /\.embed-layout/, "panes are elements now, not framed documents");
  assert.match(css, /\[data-density\] \.composer-wrap \{[^}]*display: flex;/);
  assert.match(css, /\[data-density\] \.composer-toolbar \{\s*display: contents;/);
  assert.match(css, /\[data-density\] \.composer-input \{[^}]*min-height: 0;/);
  assert.match(composer, /Math\.max\(ctx\.pane \? 0 : 48, content\)/);
});

test("a pane's composer tracks the transcript column instead of the whole surface", () => {
  const block = css.match(/\[data-density\] \.composer-wrap \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(block, /width:/, "the column width comes from the surface-width rules, not the tier");
  assert.doesNotMatch(block, /margin(-inline|-left|-right)?:/, "so do the side gutters");
  assert.match(block, /margin-bottom: 10px;/, "the tier only tightens the dock's own chrome");
});

test("phone touch layout cannot inflate a pane's composer controls", () => {
  assert.match(
    css,
    /\[data-density\] \.composer-toolbar \.icon-btn,\s*\[data-density\] \.composer-toolbar \.menu-button,\s*\[data-density\] \.composer-toolbar \.send-btn \{\s*width: 34px;\s*height: 34px;\s*min-height: 34px;/,
  );
  assert.match(css, /\[data-density\] \.composer-left,\s*\[data-density\] \.composer-right \{\s*width: auto;/);
});

test("pane settings control is visible without hover", () => {
  assert.doesNotMatch(css, /\.composer-wrap:hover \.settings-control/);
  const block = css.match(/\.settings-control \.menu-button \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(block, /opacity: 0;/);
});
