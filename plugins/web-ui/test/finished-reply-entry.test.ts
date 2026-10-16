import assert from "node:assert/strict";
import test from "node:test";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";

const step = (id: string, stopReason: string, index: number) => ({
  id,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-opus-5-5",
  stopReason,
  index,
});

function textOf(message: AssistantWork): string {
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

const interruptedAfterReply: SessionEntry[] = [
  { type: "user", seq: 1, createdAt: 100, payload: { text: "Did you shrink it?" } },
  { type: "thinking", seq: 2, createdAt: 110, payload: { thinking: "Time to answer.", step: step("s1", "stop", 0) } },
  {
    type: "text",
    seq: 3,
    createdAt: 120,
    payload: { text: "Yes, I cut it by about a third.", step: step("s1", "stop", 1) },
  },
  {
    type: "user",
    seq: 4,
    createdAt: 130,
    payload: { text: "(system note: interrupted)", hidden: true, resumeNote: true },
  },
  {
    type: "tool_call",
    seq: 5,
    createdAt: 140,
    payload: { tool: "execute", callId: "c1", command: "git diff --stat", step: step("s2", "toolUse", 0) },
  },
  { type: "tool_result", seq: 6, createdAt: 150, payload: { tool: "execute", callId: "c1", result: "ok" } },
  {
    type: "assistant",
    seq: 7,
    createdAt: 160,
    payload: { text: "Yes, I cut it by about a third. Details follow.", step: step("s3", "stop", 0) },
  },
];

test("a reply the model finished before the run continued shows as a reply, not folded work", () => {
  const messages = entriesToMessages(interruptedAfterReply) as AssistantWork[];
  const replies = messages.filter((m) => m.role === "assistant");
  assert.deepEqual(
    replies.map(textOf),
    ["Yes, I cut it by about a third.", "Yes, I cut it by about a third. Details follow."],
    "both answers are visible messages",
  );
  const [first, second] = replies;
  assert.deepEqual(
    (first as AssistantWork & { entrySeqs?: number[] }).entrySeqs,
    [3, 2],
    "the first reply owns its text entry and the thinking before it",
  );
  assert.equal(first.work?.activity.length, 1, "the thinking before the first reply folds under it");
  assert.ok(
    second.work?.activity.some((a) => a.type === "tool_call"),
    "the work after the interruption folds under the second reply",
  );
  assert.ok(
    !second.work?.activity.some((a) => a.type === "text"),
    "the finished reply is not repeated inside the second reply's fold",
  );
});

test("text from a step that also called a tool stays narration inside the fold", () => {
  const entries: SessionEntry[] = [
    { type: "user", seq: 1, createdAt: 100, payload: { text: "Check it" } },
    { type: "text", seq: 2, createdAt: 110, payload: { text: "Looking now.", step: step("s1", "toolUse", 0) } },
    {
      type: "tool_call",
      seq: 3,
      createdAt: 120,
      payload: { tool: "execute", callId: "c1", command: "ls", step: step("s1", "toolUse", 1) },
    },
    { type: "tool_result", seq: 4, createdAt: 130, payload: { tool: "execute", callId: "c1", result: "ok" } },
    { type: "assistant", seq: 5, createdAt: 140, payload: { text: "All good.", step: step("s2", "stop", 0) } },
  ];
  const replies = (entriesToMessages(entries) as AssistantWork[]).filter((m) => m.role === "assistant");
  assert.deepEqual(replies.map(textOf), ["All good."]);
  assert.ok(
    replies[0].work?.activity.some((a) => a.type === "text"),
    "the narration stays in the fold",
  );
});

test("text without step metadata keeps its old rendering inside the fold", () => {
  const entries: SessionEntry[] = [
    { type: "user", seq: 1, createdAt: 100, payload: { text: "Check it" } },
    { type: "text", seq: 2, createdAt: 110, payload: { text: "Looking now." } },
    { type: "assistant", seq: 3, createdAt: 140, payload: { text: "All good." } },
  ];
  const replies = (entriesToMessages(entries) as AssistantWork[]).filter((m) => m.role === "assistant");
  assert.deepEqual(replies.map(textOf), ["All good."]);
  assert.ok(replies[0].work?.activity.some((a) => a.type === "text"));
});
