import { test } from "node:test";
import assert from "node:assert/strict";
import { answerWebContextRequest, webConversationWindow } from "../src/api/web-context.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

const ROOT = "fb7eddc8";
const TARGET = `web:carol@acme.com:${ROOT}`;

function at(item: NewItem, seq: number): Item {
  return storedItem(item, { sessionId: "s", seq, createdAt: 1_700_000_000_000 + seq * 1000 });
}

const transcript: Item[] = [
  at({ kind: "UserMessage", text: "<wake…>", body: { display: "any policies?", name: "carol" } }, 0),
  at({ kind: "Reasoning", text: "…" }, 1),
  at({ kind: "ToolCall", tool: "web", callId: "c1", body: { action: "post", text: "Yes — the main ones are…" } }, 2),
  at({ kind: "ToolResult", tool: "web", callId: "c1", body: { action: "post", ok: true } }, 3),
  at({ kind: "AgentMessage", text: "Replied in thread." }, 4),
  at({ kind: "UserMessage", text: "hidden seed", hidden: true }, 5),
  at({ kind: "ToolCall", tool: "web", callId: "c2", body: { action: "post", bytes: 873 } }, 6),
  at({ kind: "ToolCall", tool: "web", callId: "c3", body: { action: "post", text: "this delivery failed" } }, 7),
  at(
    {
      kind: "ToolResult",
      tool: "web",
      callId: "c3",
      isError: true,
      body: { action: "post", error: "delivery failed" },
    },
    8,
  ),
  at({ kind: "ToolCall", tool: "web", callId: "c4", body: { action: "post", text: "this one was interrupted" } }, 9),
];

test("the window carries the person's display text and the agent's DELIVERED posts as `you` — never envelopes, logs, hidden seeds, or failed/interrupted posts", () => {
  const out = webConversationWindow(transcript, "carol@acme.com", ROOT, {});
  assert.deepEqual(
    out.messages.map((m) => [(m as { author: string }).author, (m as { text: string }).text]),
    [
      ["carol", "any policies?"],
      ["you", "Yes — the main ones are…"],
    ],
  );
  assert.deepEqual(out.selfTs, [(out.messages[1] as { ts: string }).ts]);
  assert.ok(
    out.messages.every((m) => (m as { threadTs?: string }).threadTs === ROOT),
    "every message is stamped with the thread root so whats_new counts it as here",
  );
  assert.equal(out.hasMore, false);
});

test("long posts are clipped so a deep read can't flood the turn's context", () => {
  const long = [
    at({ kind: "ToolCall", tool: "web", callId: "c1", body: { action: "post", text: "x".repeat(5_000) } }, 0),
    at({ kind: "ToolResult", tool: "web", callId: "c1", body: { action: "post", ok: true } }, 1),
  ];
  const out = webConversationWindow(long, "carol@acme.com", ROOT, {});
  assert.ok(
    (out.messages[0] as { text: string }).text.length <= 601,
    "message text is capped like the Slack fulfiller's window",
  );
});

test("match, count, and before shape the window like the Slack fulfiller", () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    at({ kind: "UserMessage", text: `message ${i}`, body: { name: "carol" } }, i),
  );
  const counted = webConversationWindow(many, "carol@acme.com", ROOT, { count: 2 });
  assert.deepEqual(
    counted.messages.map((m) => (m as { text: string }).text),
    ["message 4", "message 5"],
  );
  assert.equal(counted.hasMore, true);
  assert.equal(counted.nextBefore, (counted.messages[0] as { ts: string }).ts);

  const paged = webConversationWindow(many, "carol@acme.com", ROOT, { count: 2, before: counted.nextBefore });
  assert.deepEqual(
    paged.messages.map((m) => (m as { text: string }).text),
    ["message 2", "message 3"],
  );

  const matched = webConversationWindow(many, "carol@acme.com", ROOT, { match: "message 1" });
  assert.deepEqual(
    matched.messages.map((m) => (m as { text: string }).text),
    ["message 1"],
  );
});

test("answerWebContextRequest reads the log as the asking viewer, refuses gracefully, and answers searchAll/file with the right shapes", async () => {
  const seen: string[] = [];
  const items = transcript;
  const sessions = {
    async sessionsByThreadRefs(refs: readonly string[]) {
      return refs[0] === TARGET
        ? [{ id: "sess-1", threadRef: TARGET, scopeId: "channel:C1" as const, type: "channel" as const }]
        : [];
    },
    async visibleItems(_id: string, viewer: string) {
      seen.push(viewer);
      return items;
    },
    async getItems() {
      return items;
    },
    async countItemsBefore(_id: string, beforeSeq: number) {
      return items.filter((item) => item.seq < beforeSeq).length;
    },
  };

  const asViewer = await answerWebContextRequest(sessions, {
    conversationTarget: TARGET,
    viewer: "steve@acme.com",
    count: 10,
  });
  assert.ok(asViewer.result && asViewer.result.messages.length === 2);
  const fallback = await answerWebContextRequest(sessions, { conversationTarget: TARGET, count: 10 });
  assert.ok(fallback.result);
  assert.deepEqual(
    seen,
    ["steve@acme.com", "carol@acme.com"],
    "the query's viewer wins; the thread owner is the legacy fallback",
  );

  const unknown = await answerWebContextRequest(sessions, { conversationTarget: "web:carol@acme.com:nope", count: 10 });
  assert.ok(unknown.error);
  const search = await answerWebContextRequest(sessions, { conversationTarget: TARGET, searchAll: "x", count: 10 });
  assert.equal(search.result?.liveSearch, "unconfigured");
  const file = await answerWebContextRequest(sessions, { conversationTarget: TARGET, count: 1, file: { ts: "1" } });
  assert.ok(file.error);
});
