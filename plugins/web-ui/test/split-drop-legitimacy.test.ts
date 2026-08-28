import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");

test("a pane only offers the drops that will really happen", () => {
  const zones = split.match(/^function paneZonesTpl\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(zones, "paneZonesTpl not found");
  assert.match(zones, /paneShowing\(drag\.sessionId\)/, "a session already on the canvas gets no split/tab targets");
  assert.match(
    zones,
    /"Show here", \(\) => \{\n\s*endSessionDrag\(\);\n\s*focusPane\(paneId\);/,
    "its own pane offers a target that really focuses it",
  );
  assert.match(zones, /groups\.length < MAX_TILES/, "split targets vanish at the tile cap");
  assert.match(zones, /panels\.length < MAX_PANES/, "split targets also vanish at the pane ceiling");
  assert.match(split, /render\(sessionDrag \? paneZonesTpl\(this\.panelId\) : nothing, this\.zonesEl\);/);
});

test("the tab strips light up as targets from the moment the drag starts", () => {
  const joinable = split.match(/^function stripJoinable\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(joinable, "stripJoinable not found");
  assert.match(
    joinable,
    /!paneShowing\(drag\.sessionId\) && \(dockApi\?\.panels\.length \?\? 0\) < MAX_PANES/,
    "but only when a strip drop would really add a tab",
  );
  assert.match(split, /classList\.toggle\("session-dragging", stripJoinable\(\)\)/);
  assert.match(split, /classList\.remove\("session-dragging"\)/);
  assert.match(css, /\.split-canvas\.session-dragging \.dv-tabs-and-actions-container \{/);
});

test("targets and highlights stay honest when the layout changes mid-drag", () => {
  assert.match(
    split,
    /if \(sessionDrag\) refreshSessionDrag\(\);\n\s*persistSoon\(\);/,
    "a layout change during a drag recomputes the drop targets and strip highlight",
  );
});

test("session drags always target the canvas — there is no single-view handoff", () => {
  const begin = split.match(/^export function beginSessionDrag\([\s\S]*?\n}/m)?.[0] ?? "";
  assert.ok(begin, "beginSessionDrag not found");
  assert.match(begin, /refreshSessionDrag\(\);/);
  assert.doesNotMatch(split, /showSingleDropOverlay|currentChatParams|activateCanvas/);
});

test("the highlighted strip is a real drop target, not just a glow", () => {
  const strip = split.match(/^class StripDrop[\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(strip, "StripDrop not found");
  assert.match(split, /createPrefixHeaderActionComponent: \(\) => new StripDrop\(\)/, "dockview owns its lifecycle");
  assert.match(strip, /zoneTpl\("center", "Open as tab"/, "the strip offers an explicit join target");
  assert.match(strip, /tabIntoPane\(anchor\.id/, "dropping on the strip really adds a tab");
  assert.match(strip, /stripJoinable\(\)/, "and only when that drop would really add a tab");
  const end = split.match(/^export function endSessionDrag\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.match(end, /drawStripDrops\(\)/, "zones vanish when the drag ends");
  assert.match(css, /\.strip-zones \{/, "the overlay is styled");
});

test("native tab drags advertise every pane as a target from drag start", () => {
  assert.match(split, /api\.onWillDragPanel\(\(\) => beginTabDragHint\(\)\);/);
  assert.match(split, /api\.onWillDragGroup\(\(\) => beginTabDragHint\(\)\);/);
  const hint = split.match(/^function beginTabDragHint\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(hint, "beginTabDragHint not found");
  assert.match(hint, /classList\.add\("tab-dragging"\)/);
  assert.match(hint, /classList\.remove\("tab-dragging"\)/, "the hint clears when the drag ends");
  assert.match(hint, /addEventListener\("dragend"/, "cleared on dragend");
  assert.match(hint, /addEventListener\("drop"/, "and on drop");
  assert.match(css, /\.split-canvas\.tab-dragging \.dv-groupview \{/, "the target styling exists");
});
