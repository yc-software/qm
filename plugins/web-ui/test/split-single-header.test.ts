import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("a pane renders one header: the chat's own session topbar stays out of panes", () => {
  assert.match(chat, /\$\{glanceTier \|\| ctx\.pane \? nothing : sessionTopbar\([^)]*\)\}/);
});

test("the pane tab carries the scope / title breadcrumb", () => {
  assert.match(split, /function paneCrumb\(panel: IDockviewPanel\): string \| null/);
  assert.match(split, /class="split-pane-crumb"/);
  assert.match(split, /this\.element\.title = crumb \? `\$\{crumb\} \/ \$\{title\}` : title;/);
  // crumb changes must retrigger a header redraw
  assert.match(split, /\$\{paneCrumb\(p\) \?\? ""\}\|\$\{paneTitle\(p\)\}/);
  assert.match(css, /\.split-pane-crumb \{/);
});

test("project tools live behind the header overflow menu, left of the split button", () => {
  const toolsIdx = split.indexOf("split-tools-btn");
  const plusIdx = split.indexOf("Split this pane with a new session");
  assert.ok(toolsIdx > 0 && plusIdx > 0 && toolsIdx < plusIdx, "tools menu renders before the + button");
  for (const tool of ['"crons"', '"files"', '"apps"', '"skills"', '"memory"', '"keychain"']) {
    assert.ok(split.includes(`tool: ${tool}`), `${tool} reachable from the pane menu`);
  }
  assert.match(split, /switchView\(tool === "apps" \? "deploys" : tool\)/);
  assert.match(split, /setScopedSession\(\{/);
});

test("the tools menu closes on any click outside the \u22ef control \u2014 sibling buttons included", () => {
  const cls = split.slice(split.indexOf("class GroupActions"), split.indexOf("function notePaneSession"));
  assert.match(cls, /querySelector\("\.split-tools"\)\?\.contains\(e\.target as Node\)/);
  // the toggle must not swallow the click, or another pane's open menu never hears it
  const toggle = cls.slice(cls.indexOf('class="icon-btn subtle split-tools-btn'), cls.indexOf("MoreHorizontal"));
  assert.doesNotMatch(toggle, /stopPropagation/);
});

test("inline pane chrome is exactly tools, split, full screen, close", () => {
  const draw = split.slice(split.indexOf("class GroupActions"), split.indexOf("function notePaneSession"));
  // focus-over-grid moved into the menu; not an inline button
  const inlineButtons = draw.slice(draw.indexOf("const buttons"));
  assert.doesNotMatch(inlineButtons, /Focus this pane over the grid/);
  assert.match(draw, /Restore to grid \(Esc\)/); // still reachable via the menu
  assert.match(inlineButtons, /Open full screen/);
  assert.match(inlineButtons, /Close pane/);
});
