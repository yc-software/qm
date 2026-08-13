import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_TILES, serializedActiveSessionId, v1PaneSeeds } from "../src/split-layout.ts";

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

test("serializedActiveSessionId restores the active canvas tab before the dock mounts", () => {
  const layout = {
    activeGroup: "group-2",
    panels: {
      "panel-1": { params: { sessionId: "session-1" } },
      "panel-2": { params: { sessionId: "session-2" } },
    },
    grid: {
      root: {
        data: [{ data: { id: "group-1", activeView: "panel-1" } }, { data: { id: "group-2", activeView: "panel-2" } }],
      },
    },
  };
  assert.equal(serializedActiveSessionId(layout), "session-2");
});

test("serializedActiveSessionId fails closed on incomplete persisted state", () => {
  assert.equal(serializedActiveSessionId(null), null);
  assert.equal(serializedActiveSessionId({ activeGroup: "missing", panels: {}, grid: {} }), null);
});

test("a conversation can be dropped onto a pane's tab strip to become a tab", () => {
  const splitTs = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
  assert.match(splitTs, /e\.target === "tab" \|\| e\.target === "header_space"/, "no strip drop target");
  assert.match(splitTs, /api\.onDidDrop\(\(e\) => \{[\s\S]*?tabIntoPane\(/, "the strip drop must join the pane");
  const edges = [...splitTs.matchAll(/zoneTpl\("([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(edges, ["center", "left", "right", "top", "bottom"], "the body zones must not restate the strip");
});
