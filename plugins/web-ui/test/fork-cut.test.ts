import { test } from "node:test";
import assert from "node:assert/strict";
import { forkCutSeq, userMessagesBefore, type SessionEntry } from "../src/core-bridge.ts";

function entry(seq: number, type: SessionEntry["type"], payload: unknown = { text: "x" }): SessionEntry {
  return { seq, type, payload, createdAt: seq };
}

const LOG: SessionEntry[] = [
  entry(0, "user", { text: "first" }),
  entry(1, "tool_call"),
  entry(2, "tool_result"),
  entry(3, "assistant", { text: "reply one" }),
  entry(4, "user", { text: "second" }),
  entry(5, "assistant", { text: "reply two" }),
];

test("forking a user message cuts at that user entry", () => {
  assert.equal(forkCutSeq(LOG, 1, true), 0);
  assert.equal(forkCutSeq(LOG, 2, true), 4);
});

test("forking an assistant message keeps its whole turn (tools included)", () => {
  assert.equal(forkCutSeq(LOG, 1, false), 3);
});

test("forking the last assistant message copies everything", () => {
  assert.equal(forkCutSeq(LOG, 2, false), undefined);
});

test("blank user entries do not consume an ordinal (mirrors entriesToMessages)", () => {
  const log = [
    entry(0, "user", { text: "" }),
    entry(1, "user", { text: "real" }),
    entry(2, "assistant", { text: "r" }),
  ];
  assert.equal(forkCutSeq(log, 1, true), 1);
});

test("an attachments-only user entry counts as a message", () => {
  const log = [entry(0, "user", { text: "", attachments: [{ name: "a.png" }] }), entry(1, "assistant", { text: "r" })];
  assert.equal(forkCutSeq(log, 1, true), 0);
});

test("a hidden proactive-opener user entry does not consume an ordinal", () => {
  const log = [
    entry(0, "user", { text: "open", hidden: true }),
    entry(1, "user", { text: "real" }),
    entry(2, "assistant", { text: "r" }),
  ];
  assert.equal(forkCutSeq(log, 1, true), 1, "the first real user message is ordinal 1, not the hidden opener");
});

test("userMessagesBefore counts the full log's user messages ahead of a tail anchor", () => {
  assert.equal(userMessagesBefore(LOG, 4), 1);
  assert.equal(userMessagesBefore(LOG, 0), 0);
  assert.equal(userMessagesBefore(LOG, 999), 2);
});

test("userMessagesBefore skips entries that never rendered (hidden/blank), like forkCutSeq", () => {
  const log = [
    entry(0, "user", { text: "", hidden: true }),
    entry(1, "user", { text: "real" }),
    entry(2, "assistant", { text: "r" }),
    entry(3, "user", { text: "second" }),
  ];
  assert.equal(userMessagesBefore(log, 3), 1, "the hidden opener consumes no ordinal");
});
