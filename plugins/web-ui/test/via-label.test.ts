import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsToMessages, type AssistantWork } from "../src/core-bridge.ts";
import { viaHref, viaSourceText } from "../src/via-label.ts";
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

test("a delivered post carries its source's title and id for its attribution line", () => {
  const [posted] = itemsToMessages([
    item(1, {
      kind: "AgentMessage",
      variant: null,
      text: "Morning digest",
      body: { via: "cron", sourceTitle: "Gmail unread digest", sourceId: "abc123" },
    }),
  ]).filter((m) => m.role === "assistant") as AssistantWork[];
  assert.deepEqual([posted!.via, posted!.viaTitle, posted!.viaId], ["cron", "Gmail unread digest", "abc123"]);
});

test("the attribution line names the cron, falling back to the kind of source", () => {
  assert.equal(viaSourceText("cron", "Gmail unread digest"), "Gmail unread digest");
  assert.equal(viaSourceText("cron"), "Scheduled task");
  assert.equal(viaSourceText("webhook"), "Webhook");
  assert.equal(viaSourceText("monitor"), "Monitor");
});

test("the attribution line links a cron or webhook post to that cron's or webhook's page", () => {
  assert.equal(viaHref({ via: "cron", viaId: "abc123" }), "/crons/abc123");
  assert.equal(viaHref({ via: "webhook", viaId: "wh9" }), "/webhooks/wh9");
  assert.equal(viaHref({ via: "webhook" }), null);
  assert.equal(viaHref({ via: "monitor", viaId: "m1" }), null);
});
