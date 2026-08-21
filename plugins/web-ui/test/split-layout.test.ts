import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyPaneSeed,
  isLiveCanvasState,
  layoutNeedsSessionList,
  MAX_TILES,
  paneSeedMatchesSession,
  parsePaneSeed,
  serializedPaneParams,
  v1PaneSeeds,
} from "../src/split-layout.ts";

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

test("v1PaneSeeds rejects non-string pane ids", () => {
  const raw = { active: true, root: split({ kind: "leaf", id: "x", sessionId: 7, threadRef: "" }, leaf("s2")) };
  assert.equal(v1PaneSeeds(raw), null);
});

test("pane seeds have one parser and load classification", () => {
  assert.deepEqual(parsePaneSeed({ sessionId: "s1", threadRef: "t1" }), { sessionId: "s1", threadRef: "t1" });
  assert.deepEqual(parsePaneSeed({ scopeId: "project:fixture" }), { sessionId: null, threadRef: null });
  assert.equal(parsePaneSeed({ sessionId: 7 }), null);
  assert.equal(classifyPaneSeed({ sessionId: "s1" }), "session");
  assert.equal(classifyPaneSeed({ threadRef: "t1" }), "continuable");
  assert.equal(classifyPaneSeed({}), "blank");
  assert.equal(classifyPaneSeed({ threadRef: false }), "invalid");
  assert.equal(paneSeedMatchesSession({ sessionId: "s1" }, "s1", "t1"), true);
  assert.equal(paneSeedMatchesSession({ threadRef: "t1" }, "s1", "t1"), true);
  assert.equal(paneSeedMatchesSession({ threadRef: "t2" }, "s1", "t1"), false);
  assert.equal(serializedPaneParams(null), undefined);
  assert.equal(serializedPaneParams(7), undefined);
  assert.deepEqual(serializedPaneParams({ params: { threadRef: "t1" } }), { threadRef: "t1" });
});

test("v2 session-list dependencies use pane load classification", () => {
  assert.equal(layoutNeedsSessionList({ panels: { a: { params: { sessionId: "s1" } } } }), false);
  assert.equal(layoutNeedsSessionList({ panels: { a: { params: { threadRef: "t1" } } } }), true);
  assert.equal(layoutNeedsSessionList({ panels: { a: { params: {} } } }), false);
  assert.equal(layoutNeedsSessionList({ panels: { a: { params: { sessionId: 7 } } } }), false);
  assert.equal(layoutNeedsSessionList({ panels: { a: null, b: 7 } }), false);
});

test("a canvas is live only while its populated dock is attached to the current host", () => {
  assert.equal(isLiveCanvasState({ active: true, hasDock: true, hostAttached: true, panelCount: 1 }), true);
  assert.equal(isLiveCanvasState({ active: true, hasDock: true, hostAttached: false, panelCount: 1 }), false);
  assert.equal(isLiveCanvasState({ active: true, hasDock: true, hostAttached: true, panelCount: 0 }), false);
  assert.equal(isLiveCanvasState({ active: false, hasDock: true, hostAttached: true, panelCount: 1 }), false);
});

test("a conversation can be dropped onto a pane's tab strip to become a tab", () => {
  const splitTs = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  assert.match(splitTs, /e\.target === "tab" \|\| e\.target === "header_space"/, "no strip drop target");
  assert.match(splitTs, /api\.onDidDrop\(\(e\) => \{[\s\S]*?tabIntoPane\(/, "the strip drop must join the pane");
  const edges = new Set([...splitTs.matchAll(/zoneTpl\("([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual(
    edges,
    new Set(["center", "left", "right", "top", "bottom"]),
    "the body zones must not restate the strip",
  );
});
