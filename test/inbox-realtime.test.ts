import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxLedger, type IngestEntryInput, type LatestEvent } from "../src/inbox/ledger.ts";
import { createInboxRealtime } from "../src/inbox/realtime.ts";
import { slackConversationRef } from "../src/inbox/sources/slack.ts";
import type { LedgerEvent } from "../src/inbox/events.ts";
import type { Cron } from "../src/types.ts";

const CRON = { id: "cron-inbox", owner: "owner@example.com", inbox: { source: "slack" } } as unknown as Cron;

function slackEntry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    cronId: CRON.id,
    dedupeKey: "D123",
    source: "slack",
    summary: "any update?",
    sourcePayload: {
      source: "slack",
      title: "DM with Sam",
      from: "Sam",
      snippet: "any update?",
      slack: { channelId: "D123", ts: "1000.100", isDirectMessage: true },
    },
    sourceAt: 1_000_100,
    ...over,
  };
}

function gmailEntry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    cronId: CRON.id,
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

function realtime(items: ReturnType<typeof createInboxLedger>) {
  const calls: Array<[string, LatestEvent]> = [];
  const rt = createInboxRealtime({
    crons: { list: async () => [CRON] },
    items,
    record: async (item, event) => {
      calls.push([item.sourceKey, event]);
      await items.recordEvent(item, event);
    },
  });
  return Object.assign(rt, { calls });
}

test("the owner's own reply is queued as an owner event for the card's conversation", async () => {
  const items = createInboxLedger();
  await items.ingest([slackEntry()]);
  const rt = realtime(items);
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "D123",
    at: 2_000_000,
    text: "on it!",
    senderEmail: "Owner@Example.com",
  });
  assert.deepEqual(rt.calls, [["D123", { author: "owner", at: 2_000_000, text: "on it!", from: "Owner@Example.com" }]]);
  const [item] = await items.byCron(CRON.id);
  assert.equal(item!.status, "queued");
  assert.equal(item!.sourceAt, 2_000_000);
  assert.deepEqual(item!.sourcePayload?.latestEvent, { author: "owner", at: 2_000_000, text: "on it!" });
});

test("someone else's messages are queued as other events with their sender", async () => {
  const items = createInboxLedger();
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
  const payloads = Object.fromEntries(
    (await items.byCron(CRON.id)).map((item) => [
      item.sourceKey,
      {
        latestEvent: item.sourcePayload?.latestEvent,
        receivedAt: item.sourcePayload?.receivedAt,
        snippet: item.sourcePayload?.snippet,
      },
    ]),
  );
  assert.deepEqual(payloads, {
    D123: {
      latestEvent: { author: "other", at: 3_000_000, from: "sam@example.com" },
      receivedAt: 3_000_000,
      snippet: "ping",
    },
    "gmail:t-1": {
      latestEvent: { author: "other", at: 3_001_000, from: "ada@example.com" },
      receivedAt: 3_001_000,
      snippet: "any word?",
    },
  });
});

test("events in unrelated conversations or other sources queue nothing", async () => {
  const items = createInboxLedger();
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
      senderEmail: CRON.owner,
    });
  assert.deepEqual(rt.calls, []);
});

test("a thread reply reaches a channel card anchored at the thread root", async () => {
  const items = createInboxLedger();
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
    senderEmail: CRON.owner,
  });
  assert.deepEqual(rt.calls, [["C9:100.1", { author: "owner", at: 2_000_000, text: "done", from: CRON.owner }]]);
});

test("slack conversation refs key DMs by channel and channel asks by thread root", () => {
  assert.equal(slackConversationRef("D123", "100.1", undefined, true), "D123");
  assert.equal(slackConversationRef("G77", "100.1", "100.1", true), "G77:100.1");
  assert.equal(slackConversationRef("C77", "100.1", undefined, true), "C77");
  assert.equal(slackConversationRef("D9", "200.2", undefined, false), "D9:200.2");
  assert.equal(slackConversationRef("C9", "200.2", "100.1", false), "C9:100.1");
});

test("ledger mutations emit change events", async () => {
  const events: LedgerEvent[] = [];
  const items = createInboxLedger(undefined, (e) => events.push(e));
  await items.ingest([slackEntry()]);
  const [item] = await items.byCron(CRON.id);
  await items.setProposal(item!.id, { data: { body: "draft" }, by: "agent" });
  await items.recordAction(item!.id, { kind: "replied", outcome: "dismissed" });
  assert.deepEqual(
    events.map((e) => e.op),
    ["ingest", "proposal", "action"],
  );
  assert.ok(events.every((e) => e.cronId === CRON.id && e.itemId === item!.id));
});

test("private-channel mentions stay anchored to their thread, not the channel tail", () => {
  assert.equal(slackConversationRef("GPRIVATE", "200.2", "100.1", false), "GPRIVATE:100.1");
});
