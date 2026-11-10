import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsToMessages, type AssistantWork } from "../src/core-bridge.ts";
import { assistantSpeakerText, sourceText } from "../src/via-label.ts";
import type { Item } from "../src/items.ts";

const item = (seq: number, over: Partial<Item>): Item =>
  ({ seq, turnId: `t${seq}`, createdAt: seq * 1000, body: {}, ...over }) as Item;

test("a scheduled task's post after unfinished work is its own assistant message marked with where it came from", () => {
  const messages = itemsToMessages([
    item(1, { kind: "UserMessage", text: "post here in 3 minutes" }),
    item(2, { kind: "AgentMessage", variant: null, text: "Will post once." }),
    item(3, { kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "ls" } }),
    item(4, { kind: "AgentMessage", variant: null, text: "live check 2", body: { via: "cron" } }),
  ]) as AssistantWork[];
  assert.deepEqual(
    messages
      .filter((m) => m.role === "assistant")
      .map((m) => [m.content.map((c) => (c as { text: string }).text).join(""), m.via]),
    [
      ["Will post once.", undefined],
      ["", undefined],
      ["live check 2", "cron"],
    ],
  );
});

test("an automated post names its source in the assistant speaker label", () => {
  assert.equal(assistantSpeakerText("QM", "cron"), "QM · Scheduled task");
  assert.equal(assistantSpeakerText("QM", "webhook"), "QM · Webhook");
  assert.equal(assistantSpeakerText("QM", "monitor"), "QM · Monitor");
  assert.equal(assistantSpeakerText("QM", undefined), "QM");
});

test("an automated post in an unlabelled conversation is captioned with its source alone", () => {
  assert.equal(sourceText("cron"), "Scheduled task");
  assert.equal(sourceText("webhook"), "Webhook");
  assert.equal(sourceText("monitor"), "Monitor");
});
