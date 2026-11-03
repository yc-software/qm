import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { activityItems } from "../src/items.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { itemsToMessages, type AssistantWork } from "../src/core-bridge.ts";

const step = (id: string, stopReason: string, index: number, body: Record<string, unknown> = {}) => ({
  step: index,
  body: {
    ...body,
    wire: {
      message: { id, api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", stopReason },
    },
  },
});

function textOf(message: AssistantWork): string {
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

const interruptedAfterReply: Item[] = [
  item("UserMessage", { seq: 1, createdAt: 100, text: "Did you shrink it?" }),
  item("Reasoning", { seq: 2, createdAt: 110, text: "Time to answer.", ...step("s1", "stop", 0) }),
  item("AgentMessage", {
    seq: 3,
    createdAt: 120,
    variant: "narration",
    text: "Yes, I cut it by about a third.",
    ...step("s1", "stop", 1),
  }),
  item("UserMessage", {
    seq: 4,
    createdAt: 130,
    text: "(system note: interrupted)",
    hidden: true,
    body: { resumeNote: true },
  }),
  item("ToolCall", {
    seq: 5,
    createdAt: 140,
    tool: "execute",
    callId: "c1",
    ...step("s2", "toolUse", 0, { command: "git diff --stat" }),
  }),
  item("ToolResult", { seq: 6, createdAt: 150, tool: "execute", callId: "c1", text: "ok" }),
  item("AgentMessage", {
    seq: 7,
    createdAt: 160,
    text: "Yes, I cut it by about a third. Details follow.",
    ...step("s3", "stop", 0),
  }),
];

test("a reply the model finished before the run continued shows as a reply, not folded work", () => {
  const messages = itemsToMessages(interruptedAfterReply) as AssistantWork[];
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
    activityItems(second.work?.activity ?? []).some((a) => a.kind === "ToolCall"),
    "the work after the interruption folds under the second reply",
  );
  assert.ok(
    !activityItems(second.work?.activity ?? []).some((a) => a.kind === "AgentMessage"),
    "the finished reply is not repeated inside the second reply's fold",
  );
});

test("text from a step that also called a tool stays narration inside the fold", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 100, text: "Check it" }),
    item("AgentMessage", {
      seq: 2,
      createdAt: 110,
      variant: "narration",
      text: "Looking now.",
      ...step("s1", "toolUse", 0),
    }),
    item("ToolCall", {
      seq: 3,
      createdAt: 120,
      tool: "execute",
      callId: "c1",
      ...step("s1", "toolUse", 1, { command: "ls" }),
    }),
    item("ToolResult", { seq: 4, createdAt: 130, tool: "execute", callId: "c1", text: "ok" }),
    item("AgentMessage", { seq: 5, createdAt: 140, text: "All good.", ...step("s2", "stop", 0) }),
  ];
  const replies = (itemsToMessages(items) as AssistantWork[]).filter((m) => m.role === "assistant");
  assert.deepEqual(replies.map(textOf), ["All good."]);
  assert.ok(
    activityItems(replies[0].work?.activity ?? []).some((a) => a.kind === "AgentMessage"),
    "the narration stays in the fold",
  );
});

test("text without step metadata keeps its old rendering inside the fold", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 100, text: "Check it" }),
    item("AgentMessage", { seq: 2, createdAt: 110, variant: "narration", text: "Looking now." }),
    item("AgentMessage", { seq: 3, createdAt: 140, text: "All good." }),
  ];
  const replies = (itemsToMessages(items) as AssistantWork[]).filter((m) => m.role === "assistant");
  assert.deepEqual(replies.map(textOf), ["All good."]);
  assert.ok(activityItems(replies[0].work?.activity ?? []).some((a) => a.kind === "AgentMessage"));
});
