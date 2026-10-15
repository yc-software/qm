import assert from "node:assert/strict";
import test from "node:test";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";
import { workSeconds } from "../src/work-duration.ts";

for (const text of ["", "Partial answer", "(stopped)"]) {
  test(`stopped history preserves status, content and timing: ${JSON.stringify(text)}`, () => {
    const entries: SessionEntry[] = [
      {
        type: "assistant",
        payload: { text, stopped: true, workStartedAt: 1000, workFinishedAt: 4000 },
        createdAt: 4000,
        seq: 1,
      },
    ];
    const messages = entriesToMessages(entries);
    assert.equal(messages.length, 1);
    const message = messages[0] as AssistantWork;
    assert.equal(message.stopReason, "aborted");
    assert.deepEqual(message.content, [{ type: "text", text }]);
    assert.equal(workSeconds(message.work!), 3);
  });
}

test("legacy stopped placeholders are recognized without treating ordinary replies as cancellation", () => {
  for (const [text, reason] of [
    ["(stopped)", "aborted"],
    ["The process stopped.", "stop"],
  ]) {
    const message = entriesToMessages([
      { type: "assistant", payload: { text }, createdAt: 1000, seq: 1 },
    ])[0] as AssistantWork;
    assert.equal(message.stopReason, reason);
  }
});

test("a stop note renders as the stopped state, once, and never as a user message", () => {
  const note = (seq: number): SessionEntry => ({
    type: "user",
    payload: { text: "[system] Turn stopped: a person stopped it.", hidden: true, stopped: true },
    createdAt: 5000,
    seq,
  });
  const request: SessionEntry = { type: "user", payload: { text: "do the thing" }, createdAt: 1000, seq: 1 };

  const bare = entriesToMessages([request, note(2)]);
  assert.equal(bare.length, 2);
  assert.equal((bare[1] as AssistantWork).stopReason, "aborted");
  assert.deepEqual((bare[1] as AssistantWork).content, [{ type: "text", text: "" }]);

  const withPartial = entriesToMessages([
    request,
    { type: "assistant", payload: { text: "Partial answer", stopped: true }, createdAt: 4000, seq: 2 },
    note(3),
  ]);
  assert.equal(withPartial.length, 2, "the partial answer already shows the stopped state");
  assert.equal((withPartial[1] as AssistantWork).stopReason, "aborted");
  assert.deepEqual((withPartial[1] as AssistantWork).content, [{ type: "text", text: "Partial answer" }]);
});
