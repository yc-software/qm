import assert from "node:assert/strict";
import test from "node:test";
import { dropAddsTile, MAX_PANES, MAX_TILES, serializedTileCount, v1PaneSeeds } from "../src/split-layout.ts";

const leaf = (views: string[]): object => ({ type: "leaf", data: { views, activeView: views[0], id: "g" } });
const branch = (...kids: object[]): object => ({ type: "branch", data: kids });

test("the tile cap counts tiles and turns the overflow into a tab", () => {
  assert.ok(MAX_PANES >= MAX_TILES, "the conversation ceiling must allow every tile to be used");
});

test("a revived canvas is bounded by both caps and cannot blow the stack", () => {
  const tiles = (...kids: object[]): object => ({ grid: { root: branch(...kids) } });
  assert.equal(serializedTileCount(tiles(leaf(["a", "b", "c"]), leaf(["d"]))), 2, "tabs are not tiles");
  assert.equal(serializedTileCount(tiles(branch(leaf(["a"]), leaf(["b"])), branch(leaf(["c"]), leaf(["d"])))), 4);
  assert.equal(
    serializedTileCount(tiles(...Array.from({ length: MAX_TILES }, (_, i) => leaf([String(i)])))),
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
  assert.equal(dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 2 }), true, "a tab out of a shared tile");
  assert.equal(dropAddsTile({ edge: false, wholeTile: false, sourceTilePanes: 2 }), false, "joining a tab strip");
  assert.equal(dropAddsTile({ edge: true, wholeTile: true, sourceTilePanes: 1 }), false, "a whole tile only moves");
  assert.equal(
    dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 1 }),
    false,
    "the last pane out of a tile takes that tile with it",
  );
  assert.equal(dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 0 }), true, "an unrecognized drag");
});
