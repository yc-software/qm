import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToMessages, forkCutSeq, type SessionEntry } from "../src/core-bridge.ts";

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
const ROWS = entriesToMessages(LOG);

test("forking a user message cuts at that user entry", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 0), 0);
  assert.equal(forkCutSeq(LOG, ROWS, 2), 4);
});

test("forking an assistant message keeps its whole turn (tools included)", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 1), 3);
});

test("forking the last assistant message stops at the entries that existed when clicked", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 3), 5);
});

test("a fork's rows cut at their own entries, not at inherited ones", () => {
  const rows = entriesToMessages(LOG.slice(4));
  assert.equal(forkCutSeq(LOG, rows, 0, 3), 4);
  assert.equal(forkCutSeq(LOG, [{ role: "user", content: "second" }], 0, 3), 4);
});

test("an unsaved live prompt maps to the next saved user entry after the last saved row", () => {
  const live = [...entriesToMessages(LOG.slice(0, 4)), { role: "user", content: "second" }];
  assert.equal(forkCutSeq(LOG, live, 2), 4);
  assert.equal(forkCutSeq(LOG.slice(0, 4), live, 2), undefined);
  const resumed = [
    ...entriesToMessages(LOG.slice(0, 4)),
    { role: "user", content: "", resumeAnchor: true },
    { role: "assistant" },
  ];
  assert.equal(forkCutSeq(LOG, resumed, 3), 3);
});
