import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopItemLedger, type IngestEntryInput } from "../src/loops/item-ledger.ts";
import { createInboxRealtime } from "../src/loops/inbox-realtime.ts";
import { renderSourceInboxTask } from "../src/loops/inbox-loop.ts";
import { slackConversationRef } from "../src/loops/sources/slack.ts";
import type { LedgerEvent } from "../src/loops/ledger-events.ts";
import type { Loop } from "../src/types.ts";
import type { IngressEntry } from "../src/loops/ingress.ts";

const LOOP = { id: "loop-inbox", owner: "owner@example.com", surface: "inbox" } as unknown as Loop;

function slackEntry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    loopId: LOOP.id,
    dedupeKey: "D123",
    source: "slack",
    summary: "any update?",
    sourcePayload: {
      source: "slack",
      title: "DM with Sam",
      from: "Sam",
      snippet: "any update?",
      slack: { channelId: "D123", ts: "1000.100" },
    },
    sourceAt: 1_000_100,
    ...over,
  };
}

function gmailEntry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    loopId: LOOP.id,
    dedupeKey: "gmail:t-1",
    source: "gmail",
    summary: "contract question",
    sourcePayload: {
      source: "gmail",
      title: "Contract question",
      from: "Ada",
      snippet: "contract question",
      gmail: { threadId: "t-1" },
    },
    sourceAt: 1_000_100,
    ...over,
  };
}

function realtime(items: ReturnType<typeof createLoopItemLedger>) {
  const calls: IngressEntry[][] = [];
  const rt = createInboxRealtime({
    loops: { list: async () => [LOOP] },
    items,
    enqueue: async (_loop, entries) => {
      calls.push(entries);
    },
  });
  return Object.assign(rt, { calls });
}

const latest = (entries: IngressEntry[] | undefined) =>
  entries?.map((entry) => [entry.dedupeKey, entry.sourcePayload?.latestEvent]);

test("the owner's own reply is queued as an owner event for the card's conversation", async () => {
  const items = createLoopItemLedger();
  await items.ingest([slackEntry()]);
  const rt = realtime(items);
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "D123",
    at: 2_000_000,
    text: "on it!",
    senderEmail: "Owner@Example.com",
  });
  assert.deepEqual(latest(rt.calls[0]), [["D123", { author: "owner", at: 2_000_000, text: "on it!" }]]);
  assert.equal(rt.calls[0]![0]!.merge, true);
  assert.equal(rt.calls[0]![0]!.sourceAt, 2_000_000);
});

test("someone else's messages are queued as other events with their sender", async () => {
  const items = createLoopItemLedger();
  await items.ingest([slackEntry(), gmailEntry()]);
  const rt = realtime(items);
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "D123",
    at: 3_000_000,
    text: "ping",
    senderEmail: "sam@example.com",
  });
  await rt.onConversationEvent({
    source: "gmail",
    conversationRef: "t-1",
    at: 3_001_000,
    text: "any word?",
    senderEmail: "ada@example.com",
  });
  assert.deepEqual(
    rt.calls.map((entries) => entries.map((entry) => [entry.dedupeKey, entry.sourcePayload])),
    [
      [
        [
          "D123",
          {
            latestEvent: { author: "other", at: 3_000_000, from: "sam@example.com" },
            receivedAt: 3_000_000,
            snippet: "ping",
          },
        ],
      ],
      [
        [
          "gmail:t-1",
          {
            latestEvent: { author: "other", at: 3_001_000, from: "ada@example.com" },
            receivedAt: 3_001_000,
            snippet: "any word?",
          },
        ],
      ],
    ],
  );
});

test("events in unrelated conversations or other sources queue nothing", async () => {
  const items = createLoopItemLedger();
  await items.ingest([
    slackEntry({
      dedupeKey: "C9:100.1",
      sourcePayload: {
        source: "slack",
        title: "#eng",
        from: "Ada",
        snippet: "thread ask",
        slack: { channelId: "C9", ts: "100.1", threadTs: "100.1" },
      },
    }),
    slackEntry({
      dedupeKey: "D124",
      sourcePayload: { slack: { channelId: "D124", ts: "2.0", isDirectMessage: true } },
    }),
    gmailEntry(),
  ]);
  const rt = realtime(items);
  for (const [source, conversationRef] of [
    ["slack", "C9:200.2"],
    ["slack", "D999"],
    ["slack", "t-1"],
    ["gmail", "t-other"],
    ["slack", "D124:1.0"],
  ])
    await rt.onConversationEvent({
      source: source!,
      conversationRef: conversationRef!,
      at: 2_000_000,
      senderEmail: LOOP.owner,
    });
  assert.deepEqual(rt.calls, []);
});

test("a thread reply reaches a channel card anchored at the thread root", async () => {
  const items = createLoopItemLedger();
  await items.ingest([
    slackEntry({
      dedupeKey: "C9:100.1",
      sourcePayload: {
        source: "slack",
        title: "#eng",
        from: "Ada",
        snippet: "thread ask",
        slack: { channelId: "C9", ts: "100.1" },
      },
    }),
  ]);
  const rt = realtime(items);
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "C9:100.1",
    at: 2_000_000,
    text: "done",
    senderEmail: LOOP.owner,
  });
  assert.deepEqual(latest(rt.calls[0]), [["C9:100.1", { author: "owner", at: 2_000_000, text: "done" }]]);
});

test("slack conversation refs key DMs by channel and channel asks by thread root", () => {
  assert.equal(slackConversationRef("D123", "100.1"), "D123");
  assert.equal(slackConversationRef("G77", "100.1", "100.1"), "G77:100.1");
  assert.equal(slackConversationRef("C77", "100.1", undefined, true), "C77");
  assert.equal(slackConversationRef("C9", "200.2"), "C9:200.2");
  assert.equal(slackConversationRef("C9", "200.2", "100.1"), "C9:100.1");
});

test("ledger mutations emit change events", async () => {
  const events: LedgerEvent[] = [];
  const items = createLoopItemLedger(undefined, (e) => events.push(e));
  await items.ingest([slackEntry()]);
  const [item] = await items.byLoop(LOOP.id);
  await items.setProposal(item!.id, { data: { body: "draft" }, by: "agent" });
  await items.recordAction(item!.id, { kind: "replied", outcome: "dismissed" });
  assert.deepEqual(
    events.map((e) => e.op),
    ["ingest", "proposal", "action"],
  );
  assert.ok(events.every((e) => e.loopId === LOOP.id && e.itemId === item!.id));
});

test("private-channel mentions stay anchored to their thread, not the channel tail", () => {
  assert.equal(slackConversationRef("GPRIVATE", "200.2", "100.1"), "GPRIVATE:100.1");
});

test("the inbox sync task asks for the full waiting message", () => {
  const task = renderSourceInboxTask("loop-inbox", "gmail");
  assert.match(task, /snippet \(the full text of the waiting message/);
  assert.doesNotMatch(task, /snippet \(the waiting message, <=200 chars\)/);
});
