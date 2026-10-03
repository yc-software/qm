import assert from "node:assert/strict";
import test from "node:test";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";
import { workSeconds } from "../src/work-duration.ts";

for (const text of ["", "Partial answer"]) {
  test(`stopped history preserves status, content and timing: ${JSON.stringify(text)}`, () => {
    const entries: SessionEntry[] = [
      {
        type: "assistant",
        payload: { text, workStartedAt: 1000, workFinishedAt: 4000 },
        createdAt: 4000,
        seq: 1,
        stopped: true,
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

test("only the stop mark means cancellation, never reply text or payload flags", () => {
  for (const [text, reason] of [
    ["(stopped)", "stop"],
    ["The process stopped.", "stop"],
  ]) {
    const message = entriesToMessages([
      { type: "assistant", payload: { text, stopped: true }, createdAt: 1000, seq: 1 },
    ])[0] as AssistantWork;
    assert.equal(message.stopReason, reason);
  }
});

test("a tape stop mark renders the stopped turn without a placeholder reply", () => {
  const user: SessionEntry = { type: "user", payload: { text: "go" }, createdAt: 1000, seq: 0 };
  const call: SessionEntry = { type: "tool_call", payload: { tool: "exec", callId: "c1" }, createdAt: 2000, seq: 1 };

  const bare = entriesToMessages([{ ...user, stopped: true }]);
  assert.equal(bare.length, 2);
  assert.equal((bare[1] as AssistantWork).stopReason, "aborted");
  assert.deepEqual((bare[1] as AssistantWork).content, [{ type: "text", text: "" }]);

  const working = entriesToMessages([user, { ...call, stopped: true }]);
  assert.equal(working.length, 2);
  const stopped = working[1] as AssistantWork;
  assert.equal(stopped.stopReason, "aborted");
  assert.equal(stopped.work?.activity.length, 1);

  const partial = entriesToMessages([
    user,
    { type: "assistant", payload: { text: "Partial answer" }, createdAt: 3000, seq: 2, stopped: true },
  ]);
  assert.equal(partial.length, 2);
  assert.equal((partial[1] as AssistantWork).stopReason, "aborted");
  assert.deepEqual((partial[1] as AssistantWork).content, [{ type: "text", text: "Partial answer" }]);

  const next = entriesToMessages([
    { ...user, stopped: true },
    { type: "user", payload: { text: "again" }, createdAt: 5000, seq: 1 },
    { type: "assistant", payload: { text: "done" }, createdAt: 6000, seq: 2 },
  ]);
  assert.deepEqual(
    next.map((m) => (m as AssistantWork).stopReason ?? m.role),
    ["user", "aborted", "user", "stop"],
  );
});
