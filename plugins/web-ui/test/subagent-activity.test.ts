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

test("descendant traversal reads parent links once across deep history and preserves breadth-first list order", () => {
  let reads = 0;
  const chain = Array.from({ length: 512 }, (_, index) => ({
    id: `chain-${index}`,
    get parentSessionId() {
      reads++;
      return index ? `chain-${index - 1}` : undefined;
    },
  }));
  const descendants = descendantsOf(chain, "chain-0");
  assert.equal(descendants.length, 511);
  assert.deepEqual(
    descendants.map(({ depth }) => depth),
    Array.from({ length: 511 }, (_, i) => i + 1),
  );
  assert.ok(reads <= chain.length, `Traversal read ${reads} parent links for ${chain.length} sessions`);
  assert.deepEqual(
    descendantsOf([row("a", "root"), row("b1", "b"), row("b", "root"), row("a1", "a")], "root").map(
      ({ session, depth }) => [session.id, depth],
    ),
    [
      ["a", 1],
      ["b", 1],
      ["b1", 2],
      ["a1", 2],
    ],
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

test("authoritative root summaries beat incomplete or stale loaded descendants including explicit zero", () => {
  const root = row("root", undefined, { subagents: { running: 2, waiting: 1 } });
  assert.deepEqual(rowIndicators(root, null).background, {
    jobs: 0,
    watches: 0,
    crons: 0,
    subagents: 3,
    label: "2 subagents running · 1 subagent needs you",
  });
  assert.equal(rowIndicators(root, null).awaiting, true);
  const idle = { ...root, subagents: { running: 0, waiting: 0 } };
  assert.equal(rowIndicators(idle, null, list).background, null);
  assert.equal(rowIndicators(idle, null, list).awaiting, false);
  assert.equal(rowIndicators(row("root"), null, list).background?.subagents, 3);
});

test("the strip crosses inactive ancestors and retains only the deep failed leaf for acknowledgement", () => {
  const chain = Array.from({ length: 7 }, (_, depth) =>
    row(`deep-${depth}`, depth ? `deep-${depth - 1}` : undefined, { lastTurnFailed: depth === 6 }),
  );
  const rows = subagentRows(chain, "deep-0");
  assert.deepEqual(
    rows.map((value) => [value.depth, value.state]),
    [
      [1, "done"],
      [2, "done"],
      [3, "done"],
      [4, "done"],
      [5, "done"],
      [6, "failed"],
    ],
  );
  assert.deepEqual(subagentCounts(chain, "deep-0"), { running: 0, waiting: 0 });
  assert.deepEqual(
    visibleSubagents(rows, new Set()).map((value) => value.session.id),
    ["deep-6"],
  );
  assert.deepEqual(visibleSubagents(rows, new Set([ackKey(rows.at(-1)!)])), []);
});
