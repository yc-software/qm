import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const kinds = readFileSync(new URL("../src/pane-kinds.ts", import.meta.url), "utf8");

test("a pane only offers the drops that will really happen", () => {
  const zones = split.match(/^function paneZonesTpl\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(zones, "paneZonesTpl not found");
  assert.match(zones, /const showing = drag\.existing\(\);/, "a drag already on the canvas gets no split/tab targets");
  assert.match(
    zones,
    /"Show here", \(\) => \{\n\s*endPaneDrag\(\);\n\s*focusPane\(paneId\);/,
    "its own pane offers a target that really focuses it",
  );
  assert.match(zones, /groups\.length < MAX_TILES/, "split targets vanish at the tile cap");
  assert.match(zones, /panels\.length < MAX_PANES/, "split targets also vanish at the pane ceiling");
  assert.match(split, /render\(paneDrag \? paneZonesTpl\(this\.panelId\) : nothing, this\.zonesEl\);/);
});

test("the tab strips light up as targets from the moment the drag starts", () => {
  const refresh = split.match(/^function refreshPaneDrag\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(refresh, "refreshPaneDrag not found");
  assert.match(
    refresh,
    /!drag\.existing\(\) && \(dockApi\?\.panels\.length \?\? 0\) < MAX_PANES/,
    "but only when a strip drop would really add a tab",
  );
  assert.match(split, /classList\.toggle\("session-dragging", addsTab\)/);
  assert.match(split, /classList\.remove\("session-dragging"\)/);
  assert.match(css, /\.split-canvas\.session-dragging \.dv-tabs-and-actions-container \{/);
});

test("targets and highlights stay honest when the layout changes mid-drag", () => {
  assert.match(
    split,
    /if \(paneDrag\) refreshPaneDrag\(\);\n\s*persistSoon\(\);/,
    "a layout change during a drag recomputes the drop targets and strip highlight, whatever the drag carries",
  );
});

test("the single-view overlay hides splits the drop cannot honor", () => {
  const single = split.match(/^function showSingleDropOverlay\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(single, "showSingleDropOverlay not found");
  assert.match(
    single,
    /currentChatParams\(\) !== null/,
    "a dirty unsaved chat cannot seed a pane, so no split targets",
  );
  assert.match(single, /drag\.splittableSingle\(\)/, "a drag that cannot split falls back to opening full");
  assert.match(single, /splittable \? zonesTpl\(act\) : zoneTpl\("center", "Open here", act\("center"\)\)/);
  const sessionDrag = split.match(/^export function beginSessionDrag\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(sessionDrag, "beginSessionDrag not found");
  assert.match(
    sessionDrag,
    /splittableSingle: \(\) => mainConversation\(\)\.state\.sessionId !== sessionId/,
    "dropping the chat onto itself cannot split",
  );
});

test("every pane kind shares one legitimacy path", () => {
  assert.doesNotMatch(split, /inboxView|inboxDrag|sessionDrag/, "split.ts knows kinds only through the registry");
  assert.match(kinds, /export function registerPaneKind\(kind: PaneKind\): void \{/);
  assert.doesNotMatch(
    kinds,
    /^import [^t]/m,
    "the registry stays dependency-free so registration never rides an import cycle",
  );
  const kindDrag = split.match(/^export function beginPaneKindDrag\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(kindDrag, "beginPaneKindDrag not found");
  assert.match(
    kindDrag,
    /panelParams\(p\)\[kind\.paramsKey\] === id/,
    "a kind pane already on the canvas is found by its own params key",
  );
});

test("the highlighted strip is a real drop target, not just a glow", () => {
  const strip = split.match(/^class StripDrop[\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(strip, "StripDrop not found");
  assert.match(split, /createPrefixHeaderActionComponent: \(\) => new StripDrop\(\)/, "dockview owns its lifecycle");
  assert.match(strip, /zoneTpl\("center", "Open as tab"/, "the strip offers an explicit join target");
  assert.match(strip, /tabIntoPane\(anchor\.id/, "dropping on the strip really adds a tab");
  assert.match(strip, /stripJoinable\(\)/, "and only when that drop would really add a tab");
  const end = split.match(/^export function endPaneDrag\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.match(end, /drawStripDrops\(\)/, "zones vanish when the drag ends");
  assert.match(css, /\.strip-zones \{/, "the overlay is styled");
});
