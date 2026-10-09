import test from "node:test";
import assert from "node:assert/strict";
import type { CoreSession, SessionEntry } from "../src/core-bridge.ts";
import {
  ackKey,
  descendantsOf,
  peekLines,
  subagentCounts,
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
  row("a", "root", { working: true, workingSince: 50_000 }),
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

test("running and waiting counts feed the sidebar and tab badge", () => {
  assert.deepEqual(subagentCounts(list, "root"), { running: 2, waiting: 1 });
  assert.deepEqual(subagentCounts(list, "other"), { running: 0, waiting: 0 });
  assert.equal(rowIndicators(list[0]!, null, list).awaiting, true, "a child waiting on approval lights the parent");
  assert.deepEqual(conversationBackground(list, "root", null), {
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
  assert.equal(rows[0]!.startedAt, 50_000);
  assert.equal(rows[3]!.startedAt, 1_000);
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
  const entry = (type: SessionEntry["type"], payload: unknown): SessionEntry => ({ type, payload, createdAt: 0 });
  const lines = peekLines(
    [
      entry("user", { text: "go" }),
      entry("tool_call", { tool: "sandbox", action: "exec", command: "npm test" }),
      entry("tool_result", { tool: "sandbox", ok: true }),
      entry("text", { text: "Tests  pass.\nOpening PR" }),
      entry("tool_call", { tool: "github" }),
    ],
    3,
  );
  assert.deepEqual(lines, [
    { kind: "tool", text: "sandbox exec · npm test" },
    { kind: "text", text: "Tests pass. Opening PR" },
    { kind: "tool", text: "github" },
  ]);
});
