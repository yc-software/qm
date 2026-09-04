import { test } from "node:test";
import assert from "node:assert/strict";
import { answerWebContextRequest, webConversationWindow } from "../src/api/web-context.ts";
import type { SessionEntry } from "../src/types.ts";

const ROOT = "fb7eddc8";
const TARGET = `web:carol@acme.com:${ROOT}`;

function ent(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return {
    sessionId: "s",
    seq,
    parentSeq: null,
    type,
    payload,
    scopeLabel: "org:default-org",
    createdAt: 1_700_000_000_000 + seq * 1000,
  };
}

const entries: SessionEntry[] = [
  ent("user", { text: "<wake…>", display: "any policies?", name: "carol" }, 0),
  ent("thinking", { thinking: "…" }, 1),
  ent("tool_call", { tool: "web", action: "post", text: "Yes — the main ones are…", callId: "c1" }, 2),
  ent("tool_result", { tool: "web", action: "post", ok: true, callId: "c1" }, 3),
  ent("assistant", { text: "Replied in thread." }, 4),
  ent("user", { text: "hidden seed", hidden: true }, 5),
  ent("tool_call", { tool: "web", action: "post", bytes: 873, callId: "c2" }, 6),
  ent("tool_call", { tool: "web", action: "post", text: "this delivery failed", callId: "c3" }, 7),
  ent("tool_result", { tool: "web", action: "post", error: "delivery failed", callId: "c3", isError: true }, 8),
  ent("tool_call", { tool: "web", action: "post", text: "this one was interrupted", callId: "c4" }, 9),
];

test("the window carries the person's display text and the agent's DELIVERED posts as `you` — never envelopes, logs, hidden seeds, or failed/interrupted posts", () => {
  const out = webConversationWindow(entries, "carol@acme.com", ROOT, {});
  assert.deepEqual(
    out.messages.map((m) => [(m as { author: string }).author, (m as { text: string }).text]),
    [
      ["carol", "any policies?"],
      ["you", "Yes — the main ones are…"],
    ],
  );
  assert.ok(
    out.messages.every((m) => (m as { threadTs?: string }).threadTs === ROOT),
    "every message is stamped with the thread root so whats_new counts it as here",
  );
  assert.equal(out.hasMore, false);
});

test("long posts are clipped so a deep read can't flood the turn's context", () => {
  const long = [
    ent("tool_call", { tool: "web", action: "post", text: "x".repeat(5_000), callId: "c1" }, 0),
    ent("tool_result", { tool: "web", action: "post", ok: true, callId: "c1" }, 1),
  ];
  const out = webConversationWindow(long, "carol@acme.com", ROOT, {});
  assert.ok(
    (out.messages[0] as { text: string }).text.length <= 601,
    "message text is capped like the Slack fulfiller's window",
  );
});

test("match, count, and before shape the window like the Slack fulfiller", () => {
  const many = Array.from({ length: 6 }, (_, i) => ent("user", { text: `message ${i}`, name: "carol" }, i));
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
  const sessions = {
    async sessionsByThreadRefs(refs: readonly string[]) {
      return refs[0] === TARGET
        ? [{ id: "sess-1", threadRef: TARGET, scopeId: "channel:C1" as const, type: "channel" as const }]
        : [];
    },
    async visibleEntries(_id: string, viewer: string) {
      seen.push(viewer);
      return entries;
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
  assert.equal(search.result?.note, "live-search-unconfigured");
  const file = await answerWebContextRequest(sessions, { conversationTarget: TARGET, count: 1, file: { ts: "1" } });
  assert.ok(file.error);
});
