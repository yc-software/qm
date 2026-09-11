import assert from "node:assert/strict";
import test from "node:test";
import { postCallText, postResultOk } from "../src/surface-post.ts";
import { postSpeechText, type ToolRowModel } from "../src/timeline.ts";
import type { ToolActivity } from "../src/core-bridge.ts";

const call: ToolActivity = {
  seq: 1,
  parentSeq: null,
  type: "tool_call",
  createdAt: 1,
  payload: { tool: "web", action: "post", text: "The answer", callId: "post" },
};

for (const [name, payload, ok] of [
  ["successful", { ok: true, isError: false }, true],
  ["legacy sent", { result: "[sent]", isError: false }, true],
  ["unscreened success", { result: "untrusted wrapper: [sent]", isError: false, unscreened: true }, true],
  ["failed", { ok: false }, false],
  ["error flag", { isError: true }, false],
  ["error detail", { error: "delivery failed" }, false],
  ["denied", { denied: true }, false],
  ["approval blocked", { blocked: "needs_approval" }, false],
  ["missing payload", null, false],
] as const) {
  test(`${name} post uses the same delivery decision in live and persisted views`, () => {
    const row: ToolRowModel = {
      call,
      result: { seq: 2, parentSeq: 1, type: "tool_result", createdAt: 2, payload },
    };
    assert.equal(postResultOk(payload), ok);
    assert.equal(postSpeechText(row), ok ? "The answer" : null);
    assert.equal(postSpeechText(row, true), ok ? "The answer" : null);
  });
}

test("an unconfirmed post can preview posting but cannot appear as delivered speech", () => {
  const row: ToolRowModel = { call, result: null };
  assert.equal(postSpeechText(row), null);
  assert.equal(postSpeechText(row, true), "The answer");
  row.approval = { ...call, type: "approval_request" };
  assert.equal(postSpeechText(row, true), null);
});

test("file-only posts remain eligible for transcript attachments, not text bubbles", () => {
  const payload = { action: "post", text: "", files: ["report.pdf"] };
  assert.equal(postCallText(payload), "");
  assert.equal(postSpeechText({ call: { ...call, payload }, result: null }, true), null);
});

test("non-post and legacy bytes-only calls remain tool activity", () => {
  for (const payload of [
    { action: "read", text: "not speech" },
    { action: "post", bytes: 100 },
    { action: "post", text: "  " },
  ]) {
    assert.equal(postCallText(payload), null);
    assert.equal(postSpeechText({ call: { ...call, payload }, result: null }, true), null);
  }
});
