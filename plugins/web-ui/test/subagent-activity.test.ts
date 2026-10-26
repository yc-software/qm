import { item } from "./item-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { CoreSession } from "../src/core-bridge.ts";
import {
  ackKey,
  descendantsOf,
  peekLines,
  subagentRows,
  subagentSummary,
  visibleSubagents,
} from "../src/subagent-activity.ts";
import { backgroundLabel, conversationBackground, rowIndicators } from "../src/session-list.ts";

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

test("the server's running and waiting counts feed the sidebar and tab badge", () => {
  const rolled = list.map((s) => (s.id === "root" ? { ...s, subagents: { running: 2, waiting: 1 } } : s));
  assert.equal(rowIndicators(rolled[0]!, null).awaiting, true, "a child waiting on approval lights the parent");
  assert.deepEqual(conversationBackground(rolled, "root", null), {
    jobs: 0,
    watches: 0,
    crons: 0,
    subagents: 3,
    goal: false,
    label: "2 subagents running · 1 subagent needs you",
  });
  assert.equal(backgroundLabel(1, 0, 0, 1)?.label, "1 subagent running · 1 background job running");
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

test("peek shows the latest tool steps and message", () => {
  const lines = peekLines(
    [
      item("UserMessage", { text: "go" }),
      item("ToolCall", { tool: "sandbox", body: { action: "exec", command: "npm test" } }),
      item("ToolResult", { tool: "sandbox", body: { ok: true } }),
      item("AgentMessage", { variant: "narration", text: "Tests  pass.\nOpening PR" }),
      item("ToolCall", { tool: "github" }),
    ],
    3,
  );
  assert.deepEqual(lines, [
    { kind: "tool", text: "sandbox exec · npm test" },
    { kind: "text", text: "Tests pass. Opening PR" },
    { kind: "tool", text: "github" },
  ]);
});
