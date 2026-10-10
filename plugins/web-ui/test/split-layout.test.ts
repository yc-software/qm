import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutNeedsSessionList, paneNeedsSessionList } from "../src/split-layout.ts";

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

test("a pane needs the session list only when it remembers a thread but not its session", () => {
  assert.equal(paneNeedsSessionList({ sessionId: "s1", threadRef: "t1" }), false, "named session");
  assert.equal(paneNeedsSessionList({ sessionId: "s1" }), false);
  assert.equal(paneNeedsSessionList({}), false, "a blank pane names nothing and resolves nothing");
  assert.equal(paneNeedsSessionList({ scopeId: "personal:a" } as object), false, "a project's blank pane");
  assert.equal(paneNeedsSessionList({ threadRef: "t1" }), true, "adopted-session pane");
  assert.equal(paneNeedsSessionList({ sessionId: "", threadRef: "t1" }), true, "empty is not an id");
});

test("layoutNeedsSessionList answers for a whole serialized canvas, and distrusts junk", () => {
  const layout = (params: object[]): object => ({
    panels: Object.fromEntries(params.map((p, i) => [`p${i}`, { id: `p${i}`, params: p }])),
  });
  assert.equal(layoutNeedsSessionList(layout([{ sessionId: "s1" }, { sessionId: "s2" }])), false);
  assert.equal(layoutNeedsSessionList(layout([{ sessionId: "s1" }, { threadRef: "t2" }])), true, "one is enough");
  assert.equal(layoutNeedsSessionList(null), true);
  assert.equal(layoutNeedsSessionList({}), true, "no panels map");
  assert.equal(layoutNeedsSessionList({ panels: { p0: {} } }), false, "a panel with no params seeds a blank pane");
});
