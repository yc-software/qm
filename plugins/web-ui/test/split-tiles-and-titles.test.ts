import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dropAddsTile, MAX_PANES, MAX_TILES, serializedTileCount, v1PaneSeeds } from "../src/split-layout.ts";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");

const leaf = (views: string[]): object => ({ type: "leaf", data: { views, activeView: views[0], id: "g" } });
const branch = (...kids: object[]): object => ({ type: "branch", data: kids });

test("the tile cap counts tiles and turns the overflow into a tab", () => {
  assert.match(split, /dockApi\.groups\.length >= MAX_TILES/);
  assert.doesNotMatch(split, /panels\.length >= MAX_TILES/, "the tile cap must count tiles, not conversations");
  assert.doesNotMatch(split, /limit reached/i, "a full grid must not refuse the conversation");
  const tabInto = split.match(/^function tabIntoPane\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(tabInto, "tabIntoPane not found");
  assert.doesNotMatch(tabInto, /MAX_TILES/, "tabs are what the tile cap overflows into — the tile cap cannot bind");
  assert.match(tabInto, /roomForAnotherPane\(\)/, "but the resource ceiling must");
  const splitFn = split.match(/^function splitPane\([\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(splitFn, "splitPane not found");
  assert.match(splitFn, /roomForAnotherPane\(\)/, "and it must bind splits too, not only tabs");
  assert.match(split, /function roomForAnotherPane\(\): boolean \{[\s\S]*?panels\.length \?\? 0\) < MAX_PANES/);
  assert.ok(MAX_PANES > MAX_TILES * 2, "the ceiling must sit well clear of ordinary stacking");
});

test("a revived canvas is bounded by both caps and cannot blow the stack", () => {
  assert.match(split, /if \(n < 1 \|\| n > MAX_PANES \|\| serializedTileCount\(o\.layout\) > MAX_TILES\) return;/);

  const tiles = (...kids: object[]): object => ({ grid: { root: branch(...kids) } });
  assert.equal(serializedTileCount(tiles(leaf(["a", "b", "c"]), leaf(["d"]))), 2, "tabs are not tiles");
  assert.equal(
    serializedTileCount(tiles(branch(leaf(["a"]), leaf(["b"])), branch(leaf(["c"]), leaf(["d"])))),
    MAX_TILES,
  );
  assert.equal(serializedTileCount(null), 0);
  assert.equal(serializedTileCount({ grid: { root: { type: "branch", data: "nonsense" } } }), 0);

  let deep: object = leaf(["a"]);
  for (let i = 0; i < 50_000; i++) deep = branch(deep);
  assert.equal(serializedTileCount({ grid: { root: deep } }), Infinity, "a pathological tree is over the cap");

  let v1deep: object = { kind: "leaf", id: "x", sessionId: "s", threadRef: "t" };
  for (let i = 0; i < 50_000; i++) v1deep = { kind: "split", id: "s", a: v1deep, b: v1deep };
  assert.equal(v1PaneSeeds({ active: true, root: v1deep }), null, "and so is a pathological v1 tree");
});

test("only the native drops that would add a tile are refused", () => {
  assert.match(split, /api\.onWillDrop\(holdTileCap\);/);
  assert.match(split, /group\.model\.onWillDrop\(holdTileCap\);/);
  assert.match(split, /dropAddsTile\(nativeDrop\(api, e\)\)/);

  assert.equal(dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 2 }), true, "a tab out of a shared tile");
  assert.equal(dropAddsTile({ edge: false, wholeTile: false, sourceTilePanes: 2 }), false, "joining a tab strip");
  assert.equal(dropAddsTile({ edge: true, wholeTile: true, sourceTilePanes: 1 }), false, "a whole tile only moves");
  assert.equal(
    dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 1 }),
    false,
    "the last pane out of a tile takes that tile with it",
  );
  assert.equal(dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 0 }), true, "an unrecognized drag");

  assert.match(split, /from\.panelId === null && !from\.tabGroupId/);
});

test("only strip tabs redraw, and only strip tabs can close a pane", () => {
  assert.match(split, /this\.inStrip = p\.tabLocation === "header";/);
  assert.match(split, /if \(this\.inStrip\) paneTabs\.add\(this\);/);
  const draw = split.match(/^ {2}draw\(\): void \{[\s\S]*?\n {2}\}/m)?.[0] ?? "";
  assert.ok(draw, "PaneTab.draw not found");
  const gate = draw.indexOf("this.inStrip");
  const close = draw.indexOf("split-tab-close");
  assert.ok(gate >= 0 && close > gate, "the close button must render behind the inStrip gate");
});

test("a pane title ellipsizes rather than being clipped or wrapped", () => {
  const tab = css.match(/\.dockview-theme-qm \.dv-tab \{[^}]*\}/)?.[0] ?? "";
  assert.match(tab, /flex-shrink: 1;/);
  assert.match(tab, /min-width: 0;/);
  assert.match(css, /\.split-pane-title-text \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(css, /\.split-pane-title \{[^}]*min-width: 0;/);
});

test("tabs share the strip evenly down to a legible floor", () => {
  const multi = css.match(/:not\(\.dv-single-tab\) \.dv-tab \{[^}]*\}/)?.[0] ?? "";
  assert.match(multi, /flex: 0 1 220px;/);
  assert.match(multi, /min-width: 100px;/);
  assert.match(multi, /max-width: 220px;/);
});

test("hovering a tab does not change its action-slot width", () => {
  const close = css.match(/^\.split-tab-close \{[^}]*\}/m)?.[0] ?? "";
  assert.doesNotMatch(close, /transition:[^}]*\b(?:width|min-width)\b/s);
  assert.doesNotMatch(css, /:not\(:hover\):not\(:focus-within\) \.split-tab-close \{[^}]*(?:width|min-width): 0;/);
});

test("the per-tab close floats to the end of the tab", () => {
  const close = css.match(/^\.split-tab-close \{[^}]*\}/m)?.[0] ?? "";
  assert.match(close, /margin-left: auto;/);
  assert.match(css, /\.dv-tab \.split-pane-title \{[^}]*flex: 1 1 auto;/);
  assert.match(css, /\.split-pane-title-text \{[^}]*margin-right: 6px;/);
});

test("the tab overflow menu is lifted above the panes and styled", () => {
  const anchor = css.match(/\.dockview-theme-qm \.dv-popover-anchor \{[^}]*\}/)?.[0] ?? "";
  assert.ok(Number(anchor.match(/z-index: (\d+);/)?.[1] ?? 0) >= 999, `anchor z-index too low: ${anchor}`);
  const menu = css.match(/\.dv-tabs-overflow-container \{[^}]*\}/)?.[0] ?? "";
  assert.match(menu, /background: var\(--background\);/);
  assert.match(menu, /border: 1px solid var\(--border\);/);
});

// Detached background work belongs to the conversation, so it shows wherever the
// conversation's header does: the sidebar row and — once a pane is stacked behind a tab —
// the tab. Both read one derivation, and the header signature has to move with the count
// or a tab never redraws when the work starts or ends.
test("a pane tab carries the conversation's background chip, from the sidebar's derivation", () => {
  const draw = split.match(/^ {2}draw\(\): void \{[\s\S]*?^ {2}\}/m)?.[0] ?? "";
  assert.ok(draw, "PaneTab.draw not found");
  assert.match(draw, /class="bg-chip"/, "the tab must show the same chip the sidebar row does");
  assert.match(split, /function paneBackground\([\s\S]*?conversationBackground\(sessionsState\.list,/);
  const signature = split.match(/^function computeHeaderSignature\(\)[\s\S]*?\n\}/m)?.[0] ?? "";
  assert.match(signature, /paneBackground\(p\)/, "a change in the count must move the header signature");
  // Only the sidebar's chip opens the inspector; the tab's is a mark on a tab that is
  // itself the control, so the clickable affordance hangs off the clickable one.
  assert.match(css, /\.bg-chip\[role="button"\] \{[^}]*cursor: pointer;/);
});
