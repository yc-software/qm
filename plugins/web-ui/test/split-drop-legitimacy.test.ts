import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const css = read("../src/shell.css");
const split = read("../src/split.ts");

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
  const refresh = split.match(/^function refreshSessionDrag\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(refresh, "refreshSessionDrag not found");
  assert.match(
    refresh,
    /!paneShowing\(drag\.sessionId\) && \(dockApi\?\.panels\.length \?\? 0\) < MAX_PANES/,
    "but only when a strip drop would really add a tab",
  );
  assert.match(refresh, /classList\.toggle\("session-dragging", addsTab\)/);
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
