import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopItemLedger, type IngestEntryInput } from "../src/loops/item-ledger.ts";
import { createInboxRealtime } from "../src/loops/inbox-realtime.ts";
import { slackConversationRef } from "../src/loops/sources/slack.ts";
import type { LedgerEvent } from "../src/loops/ledger-events.ts";
import type { Loop } from "../src/types.ts";

const LOOP = { id: "loop-inbox", owner: "josh@example.com", surface: "inbox" } as unknown as Loop;

function slackEntry(over: Partial<IngestEntryInput> = {}): IngestEntryInput {
  return {
    loopId: LOOP.id,
    dedupeKey: "D123",
    source: "slack",
    summary: "any update?",
    sourcePayload: {
      source: "slack",
      title: "DM with Mark",
      from: "Mark",
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

function realtime(items: ReturnType<typeof createLoopItemLedger>, requestFire?: (loopId: string) => void) {
  return createInboxRealtime({
    loops: { list: async () => [LOOP] },
    items,
    ...(requestFire ? { requestFire } : {}),
  });
}

test("the owner's own reply resolves the matching open card as replied", async () => {
  const items = createLoopItemLedger();
  await items.ingest([slackEntry()]);
  const rt = realtime(items);
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "D123",
    at: 2_000_000,
    text: "on it!",
    senderEmail: "Josh@Example.com",
  });
  const [item] = await items.byLoop(LOOP.id);
  assert.equal(item!.status, "skipped");
  assert.equal(item!.actionKind, "replied");
  assert.equal(item!.actionResult, "on it!");
});

test("someone else's message bumps the card and requests a debounced fire", async () => {
  const items = createLoopItemLedger();
  await items.ingest([slackEntry()]);
  const fires: string[] = [];
  const rt = realtime(items, (loopId) => fires.push(loopId));
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "D123",
    at: 3_000_000,
    text: "also, when works?",
    senderEmail: "mark@example.com",
  });
  await rt.onConversationEvent({
    source: "slack",
    conversationRef: "D123",
    at: 3_001_000,
    text: "ping",
    senderEmail: "mark@example.com",
  });
  const [item] = await items.byLoop(LOOP.id);
  assert.equal(item!.status, "queued");
  assert.equal(item!.sourceAt, 3_001_000);
  assert.equal(item!.sourceSummary, "ping");
  assert.equal(fires.length, 1);
});

test("events in unrelated conversations or other sources leave the ledger alone", async () => {
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
    gmailEntry(),
  ]);
  const rt = realtime(items);

  await rt.onConversationEvent({ source: "slack", conversationRef: "C9:200.2", at: 2_000_000, text: "chatter" });
  await rt.onConversationEvent({ source: "slack", conversationRef: "D999", at: 2_000_000, text: "other dm" });

  await rt.onConversationEvent({ source: "slack", conversationRef: "t-1", at: 2_000_000, text: "collide" });
  for (const item of await items.byLoop(LOOP.id)) {
    assert.equal(item.status, "queued");
    assert.equal(item.sourceAt, 1_000_100);
  }
});

test("a thread reply resolves a channel card anchored at the thread root", async () => {
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
    senderEmail: "josh@example.com",
  });
  const [item] = await items.byLoop(LOOP.id);
  assert.equal(item!.status, "skipped");
  assert.equal(item!.actionKind, "replied");
});

test("a gmail event matches cards by threadId only", async () => {
  const items = createLoopItemLedger();
  await items.ingest([gmailEntry()]);
  const rt = realtime(items);
  await rt.onConversationEvent({
    source: "gmail",
    conversationRef: "t-other",
    at: 2_000_000,
    senderEmail: "josh@example.com",
  });
  let [item] = await items.byLoop(LOOP.id);
  assert.equal(item!.status, "queued");
  await rt.onConversationEvent({
    source: "gmail",
    conversationRef: "t-1",
    at: 2_000_000,
    text: "sent, thanks",
    senderEmail: "josh@example.com",
  });
  [item] = await items.byLoop(LOOP.id);
  assert.equal(item!.status, "skipped");
  assert.equal(item!.actionResult, "sent, thanks");
});

test("someone else's gmail reply bumps the card for a redraft", async () => {
  const items = createLoopItemLedger();
  await items.ingest([gmailEntry()]);
  const fires: string[] = [];
  const rt = realtime(items, (loopId) => fires.push(loopId));
  await rt.onConversationEvent({
    source: "gmail",
    conversationRef: "t-1",
    at: 3_000_000,
    text: "bumping this — any word?",
    senderEmail: "ada@example.com",
  });
  const [item] = await items.byLoop(LOOP.id);
  assert.equal(item!.status, "queued");
  assert.equal(item!.sourceAt, 3_000_000);
  assert.equal(item!.sourceSummary, "bumping this — any word?");
  assert.deepEqual(fires, [LOOP.id]);
});

test("slack conversation refs key DMs by channel and channel asks by thread root", () => {
  assert.equal(slackConversationRef("D123", "100.1"), "D123");
  assert.equal(slackConversationRef("G77", "100.1", "100.1"), "G77");
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
