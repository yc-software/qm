import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutNeedsSessionList, paneNeedsSessionList } from "../src/split-layout.ts";

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
