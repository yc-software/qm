import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import type { Loop, LoopItem } from "../src/loops/types.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { transcriptWindow, type Conversation, type TranscriptMessage } from "../src/loops/verdict/transcript.ts";
import { parseVerdict, renderVerdictPrompt, type VerdictModel } from "../src/loops/verdict/verdict.ts";
import { changedSinceLastLook, createConversationFetcher } from "../src/loops/verdict/fetch.ts";
import {
  createInboxVerdictPass,
  INBOX_VERDICT_DISAGREEMENT,
  ledgerClassification,
} from "../src/loops/verdict/shadow.ts";
import { testMap } from "./support/test-database.ts";

const OWNER = "regan@example.com";
const loop = { id: "slack-loop", owner: OWNER } as Loop;
const tokens = { connectorAccessToken: async () => "synthetic-token" };
const json = (body: unknown) => Response.json(body);
const on = { enabled: async () => true };

function message(ts: number, owner: boolean, text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { ts: String(ts), at: ts * 1000, author: owner ? "Regan" : "Josh", owner, text, ...extra };
}

async function slackFixture(overrides: Record<string, unknown> = {}) {
  const items = createLoopItemLedger(testMap());
  await items.ingest([
    {
      loopId: loop.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 1_000_000,
      sourcePayload: {
        title: "DM with Josh",
        snippet: "Do you have a link to the repo?",
        slack: { channelId: "D1", ts: "1000.000100", isDirectMessage: true },
        participants: [{ id: "U_JOSH", name: "Josh" }],
        ...overrides,
      },
      proposal: { by: "agent", data: { body: "Here is the link" } },
    },
  ]);
  return { items, item: (await items.byLoop(loop.id))[0]! };
}

function slackApi(messages: Array<Record<string, unknown>>, calls: string[] = []) {
  return async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname.split("/").at(-1)!;
    calls.push(path);
    if (path === "auth.test") return json({ ok: true, user_id: "U_REGAN" });
    if (path === "conversations.info") return json({ ok: true, channel: { is_im: true } });
    if (path === "conversations.history") return json({ ok: true, messages: [...messages].reverse() });
    return json({ ok: false, error: `unexpected ${path}` });
  };
}

function scriptedModel(replies: string[]) {
  const prompts: string[] = [];
  const drafts: string[] = [];
  const model: VerdictModel = {
    verdict: async (_system, prompt) => {
      prompts.push(prompt);
      return replies.shift();
    },
    draft: async (_system, prompt) => {
      drafts.push(prompt);
      return JSON.stringify({ draft: "sure, it is github.com/x/y" });
    },
  };
  return { model, prompts, drafts };
}

function auditRecorder() {
  const events: AuditEvent[] = [];
  return { events, audit: { record: (event: AuditEvent) => void events.push(event) } };
}

test("transcript window keeps the thread root, the last 30 messages, and everything from the owner's last message on", () => {
  const messages = Array.from({ length: 80 }, (_, i) => message(i + 1, false, `m${i + 1}`));
  const flat = transcriptWindow({ source: "slack", label: "x", messages });
  assert.equal(flat.length, 30);
  assert.equal(flat[0]!.text, "m51");

  const threaded = transcriptWindow({ source: "slack", label: "x", rootTs: "1", messages });
  assert.equal(threaded.length, 31);
  assert.equal(threaded[0]!.text, "m1");
  assert.equal(threaded[1]!.text, "m51");

  const ownerEarly = [...messages];
  ownerEarly[9] = message(10, true, "owner answered at 10");
  const tail = transcriptWindow({ source: "slack", label: "x", messages: ownerEarly });
  assert.equal(tail.length, 71);
  assert.equal(tail[0]!.text, "owner answered at 10");

  const ownerLate = [...messages];
  ownerLate[75] = message(76, true, "owner answered at 76");
  assert.equal(transcriptWindow({ source: "slack", label: "x", messages: ownerLate }).length, 30);
});

test("verdict parser accepts strict JSON and rejects unknown states, missing reasons and prose", () => {
  const good = parseVerdict('```json\n{"state":"resolved","reason":"owner sent the link","waiting_ts":null}\n```');
  assert.deepEqual(good, { ok: true, verdict: { state: "resolved", reason: "owner sent the link", waitingTs: null } });
  const needs = parseVerdict('{"state":"needs_reply","reason":"open ask","waiting_ts":"1700.1"}');
  assert.deepEqual(needs, { ok: true, verdict: { state: "needs_reply", reason: "open ask", waitingTs: "1700.1" } });
  const resolvedWithTs = parseVerdict('{"state":"resolved","reason":"done","waiting_ts":"1700.1"}');
  assert.ok(resolvedWithTs.ok && resolvedWithTs.verdict.waitingTs === null);
  for (const bad of [
    undefined,
    "I think the owner still owes a reply.",
    '{"state":"maybe","reason":"x"}',
    '{"state":"resolved"}',
    '{"state":"needs_reply","reason":"x","waiting_ts":5}',
    '["needs_reply"]',
  ]) {
    const parsed = parseVerdict(bad);
    assert.equal(parsed.ok, false, String(bad));
  }
});

test("the fetcher reports a change only when the newest message differs from the last look", async () => {
  const { item } = await slackFixture();
  const history = [
    { ts: "1000.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
    { ts: "1000.000200", user: "U_REGAN", text: "github.com/x/y" },
  ];
  const calls: string[] = [];
  const fetchConversation = createConversationFetcher({ tokens, fetchImpl: slackApi(history, calls) });
  const first = await fetchConversation(OWNER, item);
  assert.equal(first.kind, "conversation");
  if (first.kind !== "conversation") return;
  assert.equal(changedSinceLastLook(item, first.conversation), true);
  const seen = { ...item, verdict: { lastSeenTs: "1000.000200" } as LoopItem["verdict"] };
  assert.equal(changedSinceLastLook(seen, first.conversation), false);
  history.push({ ts: "1000.000300", user: "U_JOSH", text: "Bruh" });
  const second = await fetchConversation(OWNER, item);
  assert.ok(second.kind === "conversation" && changedSinceLastLook(seen, second.conversation));
  assert.deepEqual(
    second.conversation.messages.map((m) => [m.author, m.owner]),
    [
      ["Josh", false],
      ["U_REGAN", true],
      ["Josh", false],
    ],
  );
  assert.equal(calls.filter((call) => call === "auth.test").length, 1);
  assert.equal(calls.filter((call) => call === "conversations.info").length, 1);
});

test("Gmail threads mark SENT messages as the owner's, drop drafts and decode plain-text bodies", async () => {
  const items = createLoopItemLedger(testMap());
  await items.ingest([
    {
      loopId: "mail",
      dedupeKey: "t1",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { title: "Hello", snippet: "hi", gmail: { threadId: "t1" } },
    },
  ]);
  const item = (await items.byLoop("mail"))[0]!;
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  const fetchConversation = createConversationFetcher({
    tokens,
    fetchImpl: async (url) => {
      const path = String(url);
      if (path.endsWith("/profile")) return json({ emailAddress: "Regan@Example.com" });
      assert.match(path, /threads\/t1\?format=full$/);
      return json({
        messages: [
          {
            id: "a",
            internalDate: "2000",
            labelIds: ["INBOX"],
            snippet: "snippet",
            payload: {
              headers: [
                { name: "From", value: "Josh <josh@example.com>" },
                { name: "Subject", value: "Repo link?" },
              ],
              parts: [
                { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
                {
                  mimeType: "text/plain",
                  body: { data: b64("Can you send the repo link?\n\nOn Mon, Josh wrote:\n> old") },
                },
              ],
            },
          },
          { id: "d", internalDate: "2500", labelIds: ["DRAFT"], snippet: "draft", payload: { headers: [] } },
          {
            id: "b",
            internalDate: "3000",
            labelIds: ["SENT"],
            snippet: "Here you go",
            payload: {
              headers: [{ name: "From", value: "regan@example.com" }],
              mimeType: "text/plain",
              body: { data: b64("Here you go") },
            },
          },
        ],
      });
    },
  });
  const outcome = await fetchConversation(OWNER, item);
  assert.equal(outcome.kind, "conversation");
  if (outcome.kind !== "conversation") return;
  assert.equal(outcome.conversation.label, 'Email "Repo link?"');
  assert.deepEqual(
    outcome.conversation.messages.map((m) => [m.ts, m.owner, m.text]),
    [
      ["2000", false, "Can you send the repo link?"],
      ["3000", true, "Here you go"],
    ],
  );
});

test("shadow pass stores the verdict, leaves status and payload alone, and audits only disagreements", async () => {
  const { items, item } = await slackFixture();
  const history = [
    { ts: "1000.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
    { ts: "1000.000200", user: "U_REGAN", text: "github.com/x/y" },
    { ts: "1000.000300", user: "U_JOSH", text: "Bruh" },
  ];
  const { model, prompts } = scriptedModel(['{"state":"resolved","reason":"owner sent the link","waiting_ts":null}']);
  const { audit, events } = auditRecorder();
  const pass = createInboxVerdictPass({
    featureFlags: on,
    items,
    audit,
    model,
    fetch: createConversationFetcher({ tokens, fetchImpl: slackApi(history) }),
    ownerName: async () => "Regan",
    now: () => 5_000_000,
  });
  await pass(loop);
  const after = (await items.get(item.id))!;
  assert.equal(after.status, item.status);
  assert.deepEqual(after.sourcePayload, item.sourcePayload);
  assert.equal(after.proposal?.data.body, "Here is the link");
  assert.deepEqual(after.verdict, {
    state: "resolved",
    reason: "owner sent the link",
    waitingTs: null,
    draft: null,
    lastSeenTs: "1000.000300",
    ledgerState: "needs_reply",
    at: 5_000_000,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.action, INBOX_VERDICT_DISAGREEMENT);
  assert.equal(events[0]!.resource, `loop_item:${item.id}`);
  assert.equal(events[0]!.status, "resolved");
  assert.match(events[0]!.detail!, /Inbox shows needs reply; verdict resolved: owner sent the link/);
  assert.match(prompts[0]!, /Owner: Regan \(regan@example.com\)/);
  assert.match(prompts[0]!, /owner \(U_REGAN\): github.com\/x\/y/);
  assert.match(prompts[0]!, /Owner's unsent draft from an earlier look: "Here is the link"/);

  await pass(loop);
  assert.equal(prompts.length, 1);
});

test("a textless message after the owner's answer still gets a fresh verdict and no shortcut", async () => {
  const { items, item } = await slackFixture();
  const history = [
    { ts: "1000.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
    { ts: "1000.000200", user: "U_REGAN", text: "github.com/x/y" },
    {
      ts: "1000.000300",
      user: "U_JOSH",
      text: "",
      files: [{ id: "F1", mimetype: "image/png", url_private: "https://files.slack.com/F1" }],
    },
  ];
  const { model, prompts, drafts } = scriptedModel([
    '{"state":"needs_reply","reason":"screenshot shows an error to fix","waiting_ts":"1000.000300"}',
  ]);
  const { audit, events } = auditRecorder();
  await createInboxVerdictPass({
    featureFlags: on,
    items,
    audit,
    model,
    fetch: createConversationFetcher({ tokens, fetchImpl: slackApi(history) }),
  })(loop);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Josh: \(no text\) \[1 attachment\]/);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0]!, /Waiting message: ts=1000.000300/);
  const after = (await items.get(item.id))!;
  assert.equal(after.verdict?.state, "needs_reply");
  assert.equal(after.verdict?.draft, "sure, it is github.com/x/y");
  assert.equal(after.verdict?.waitingTs, "1000.000300");
  assert.equal(events.length, 0);
});

test("ledger classification treats shipped, dismissed and probablyResolved items as resolved", async () => {
  const base = { status: "ready", sourcePayload: {} } as LoopItem;
  assert.equal(ledgerClassification(base), "needs_reply");
  assert.equal(ledgerClassification({ ...base, sourcePayload: { probablyResolved: true } }), "resolved");
  assert.equal(ledgerClassification({ ...base, status: "shipped" }), "resolved");
  assert.equal(ledgerClassification({ ...base, status: "skipped" }), "resolved");
  assert.equal(ledgerClassification({ ...base, status: "queued" }), "needs_reply");
});

test("the pass does nothing when the flag is off and logs model failures without throwing", async () => {
  const { items, item } = await slackFixture();
  const history = [{ ts: "1000.000100", user: "U_JOSH", text: "Do you have a link to the repo?" }];
  const calls: string[] = [];
  const { model, prompts } = scriptedModel(["not json at all"]);
  const errors: Array<{ code: string; message: string }> = [];
  const errorLog = { record: (event: { code: string; message: string }) => void errors.push(event) };
  const { audit, events } = auditRecorder();
  const make = (enabled: boolean) =>
    createInboxVerdictPass({
      featureFlags: { enabled: async () => enabled },
      items,
      audit,
      model,
      errors: errorLog,
      fetch: createConversationFetcher({ tokens, fetchImpl: slackApi(history, calls) }),
    });
  await make(false)(loop);
  assert.deepEqual(calls, []);
  assert.equal(prompts.length, 0);

  await make(true)(loop);
  assert.equal(prompts.length, 1);
  assert.equal((await items.get(item.id))!.verdict, undefined);
  assert.equal(events.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "verdict_failed");
  assert.match(errors[0]!.message, /verdict was not a JSON object/);
});

test("the verdict prompt marks owner messages and carries the conversation label", () => {
  const conversation: Conversation = {
    source: "slack",
    label: "DM with Josh",
    messages: [message(1, false, "question"), message(2, true, "answer")],
  };
  const prompt = renderVerdictPrompt({ owner: { id: OWNER }, conversation, now: 0 });
  assert.match(prompt, /Conversation: DM with Josh/);
  assert.match(prompt, /\[ts=1\] 1970-01-01T00:00:01.000Z Josh: question/);
  assert.match(prompt, /\[ts=2\] 1970-01-01T00:00:02.000Z owner \(Regan\): answer/);
});
