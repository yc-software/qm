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
