import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_TILES, v1PaneSeeds } from "../src/split-layout.ts";

const leaf = (sessionId: string | null = null, threadRef: string | null = null): object => ({
  kind: "leaf",
  id: "x",
  sessionId,
  threadRef,
});
const split = (a: object, b: object): object => ({ kind: "split", id: "s", dir: "row", ratio: 0.5, a, b });

test("v1PaneSeeds pulls pane contents out of a nested tree in reading order", () => {
  const raw = { active: true, root: split(leaf("s1", "t1"), split(leaf(null, "t2"), leaf("s3", "t3"))) };
  assert.deepEqual(v1PaneSeeds(raw), [
    { sessionId: "s1", threadRef: "t1" },
    { sessionId: null, threadRef: "t2" },
    { sessionId: "s3", threadRef: "t3" },
  ]);
});

test("v1PaneSeeds rejects junk, inactive payloads, and degenerate pane counts", () => {
  assert.equal(v1PaneSeeds(null), null);
  assert.equal(v1PaneSeeds("{}"), null);
  assert.equal(v1PaneSeeds({ active: false, root: split(leaf(), leaf()) }), null, "inactive");
  assert.equal(v1PaneSeeds({ active: true, root: leaf("s1") }), null, "one pane is not a canvas");
  assert.equal(v1PaneSeeds({ active: true, root: { kind: "split", a: leaf() } }), null, "malformed split");
  let wide: object = leaf();
  for (let i = 0; i < MAX_TILES; i++) wide = split(wide, leaf());
  assert.equal(v1PaneSeeds({ active: true, root: wide }), null, "over the tile cap");
});

test("v1PaneSeeds normalizes non-string ids to null", () => {
  const raw = { active: true, root: split({ kind: "leaf", id: "x", sessionId: 7, threadRef: "" }, leaf("s2")) };
  assert.deepEqual(v1PaneSeeds(raw), [
    { sessionId: null, threadRef: null },
    { sessionId: "s2", threadRef: null },
  ]);
});

test("a conversation can be dropped onto a pane's tab strip to become a tab", () => {
  const splitTs = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
  assert.match(splitTs, /class StripDrop implements IHeaderActionsRenderer/, "no strip drop target");
  assert.match(splitTs, /^class StripDrop[\s\S]*?tabIntoPane\(/m, "the strip drop must join the pane");
  const edges = new Set([...splitTs.matchAll(/zoneTpl\("([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual(
    edges,
    new Set(["center", "left", "right", "top", "bottom"]),
    "the body zones must not restate the strip",
  );
});
