import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("only full standalone chats render their own session topbar", () => {
  const expression = chat.match(/\$\{([^{}]+\? nothing : sessionTopbar\(\))\}/)?.[1];
  assert.ok(expression);
  for (const pane of [false, true]) {
    for (const editingApp of [null, "my-app"]) {
      for (const glanceTier of [null, "card", "strip"]) {
        const shown = runInNewContext(expression, {
          ctx: { pane },
          editingApp,
          glanceTier,
          nothing: false,
          sessionTopbar: () => true,
        });
        assert.equal(shown, !pane && !editingApp && !glanceTier);
      }
    }
  }
});

test("the pane tab carries the scope / title breadcrumb", () => {
  assert.match(split, /function paneCrumb\(panel: IDockviewPanel\): string \| null/);
  assert.match(split, /class="split-pane-crumb"/);
  assert.match(split, /attachTooltip\(this\.element, crumb \? `\$\{crumb\} \/ \$\{title\}` : title\);/);
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
  assert.match(cls, /e\.composedPath\(\)\.includes\(tools\)/);
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

test("a topbar-less pane keeps the two-row grid: transcript bounded, composer at the bottom", () => {
  const classes = chat.match(/class="(custom-chat-shell [\s\S]*?)"\s+@dragenter/)?.[1];
  assert.ok(classes);
  for (const pane of [false, true]) {
    for (const editingApp of [null, "my-app"]) {
      const rendered: string[] = runInNewContext(`\`${classes}\``, {
        ctx: { pane, composer: { state: { dragging: false } } },
        editingApp,
        emptyChat: false,
        glanceTier: null,
      }).split(/\s+/);
      assert.equal(rendered.includes("in-pane"), pane);
      assert.equal(rendered.includes("app-edit-chat"), Boolean(editingApp));
    }
  }
  assert.match(css, /\.custom-chat-shell\.in-pane \{\s*grid-template-rows: minmax\(0, 1fr\) auto;\s*\}/);
  assert.match(css, /\.app-edit-chat \{\s*grid-template-rows: minmax\(0, 1fr\) auto;\s*\}/);
});
