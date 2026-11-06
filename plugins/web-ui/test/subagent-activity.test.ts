import test from "node:test";
import assert from "node:assert/strict";
import type { CoreSession } from "../src/core-bridge.ts";
import { ackKey, descendantsOf, subagentRows, subagentSummary, visibleSubagents } from "../src/subagent-activity.ts";
import { conversationBackground, rowIndicators } from "../src/session-list.ts";

function row(id: string, parentSessionId?: string, extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    type: "dm",
    scopeId: "personal:a",
    threadRef: `agent:main:subagent:${id}`,
    createdAt: 1_000,
    lastActivityAt: 61_000,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...extra,
  };
}

const list = [
  row("root"),
  row("a", "root", { working: true }),
  row("b", "root", { lastTurnFailed: true }),
  row("c", "root", { awaitingInput: true }),
  row("a1", "a", { working: true }),
  row("other"),
];

test("descendants roll grandchildren up to the top-level parent", () => {
  assert.deepEqual(
    descendantsOf(list, "root").map(({ session, depth }) => [session.id, depth]),
    [
      ["a", 1],
      ["b", 1],
      ["c", 1],
      ["a1", 2],
    ],
  );
  assert.deepEqual(
    descendantsOf([row("x", "y"), row("y", "x")], "x").map(({ session }) => session.id),
    ["y"],
  );
});

test("descendants keep list order across parents and follow a replaced list", () => {
  const interleaved = [row("q1", "q"), row("p1", "p"), row("p", "root"), row("q", "root")];
  assert.deepEqual(
    descendantsOf(interleaved, "root").map(({ session }) => session.id),
    ["p", "q", "q1", "p1"],
  );
  const before = [row("root"), row("a", "root")];
  const after = [...before, row("b", "root", { working: true })];
  assert.deepEqual(
    descendantsOf(after, "root").map(({ session }) => session.id),
    ["a", "b"],
    "a new list array sees its new children",
  );
});

test("a waiting subagent lights the parent's awaiting dot but no background chip", () => {
  const rolled = list.map((s) => (s.id === "root" ? { ...s, subagents: { running: 2, waiting: 1 } } : s));
  assert.equal(rowIndicators(rolled[0]!, null).awaiting, true, "a child waiting on approval lights the parent");
  assert.equal(conversationBackground(rolled, "root", null), null, "subagents never light the background chip");
});

test("rows derive working, waiting, done and failed; done folds away, failed stays until acknowledged", () => {
  const rows = subagentRows(list, "root");
  assert.deepEqual(
    rows.map((r) => [r.session.id, r.state]),
    [
      ["a", "working"],
      ["b", "failed"],
      ["c", "waiting"],
      ["a1", "working"],
    ],
  );
  assert.equal(rows[0]!.endedAt, null);
  assert.equal(rows[1]!.endedAt, 61_000);
  assert.equal(subagentSummary(rows), "2 subagents running, 1 needs you, 1 failed");
  const failed = rows[1]!;
  assert.deepEqual(
    visibleSubagents(rows, new Set([ackKey(failed)])).map((r) => r.session.id),
    ["a", "c", "a1"],
  );
  const done = subagentRows(
    list.map((s) => (s.id === "b" ? { ...s, lastTurnFailed: false } : s)),
    "root",
  );
  assert.equal(
    visibleSubagents(done, new Set()).some((r) => r.session.id === "b"),
    false,
  );
});

test("a working subagent under an idle one moves up to the nearest shown ancestor", () => {
  const tree = [
    row("root"),
    row("a", "root", { working: true }),
    row("idle", "a"),
    row("leaf", "idle", { working: true }),
    row("top-idle", "root"),
    row("orphan", "top-idle", { working: true }),
  ];
  const rows = visibleSubagents(subagentRows(tree, "root"), new Set());
  assert.deepEqual(
    rows.map((r) => [r.session.id, r.depth]),
    [
      ["a", 1],
      ["orphan", 1],
      ["leaf", 2],
    ],
  );
  assert.equal(subagentSummary(rows), "3 subagents running");
});

test("a working subagent's clock starts at its current run, not its creation", () => {
  const rows = subagentRows(
    [
      row("root"),
      row("a", "root", { working: true, workingSince: 50_000 }),
      row("b", "root", { workingSince: 50_000 }),
    ],
    "root",
  );
  assert.equal(rows[0]!.startedAt, 50_000);
  assert.equal(rows[1]!.startedAt, 1_000);
});
