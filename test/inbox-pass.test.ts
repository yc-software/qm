import assert from "node:assert/strict";
import { ErrorCode } from "@slack/web-api";
import { test } from "node:test";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import type { Loop, LoopItem } from "../src/loops/types.ts";
import { transcriptWindow, type Conversation, type TranscriptMessage } from "../src/loops/verdict/transcript.ts";
import { parseVerdict, renderVerdictPrompt, type VerdictModel } from "../src/loops/verdict/verdict.ts";
import {
  changedSinceLastLook,
  createConversationFetcher,
  createSourceClients,
  slackPermalink,
} from "../src/loops/verdict/fetch.ts";
import { createDiscoverer, scanSince } from "../src/loops/verdict/discover.ts";
import { conversationPayload } from "../src/loops/verdict/payload.ts";
import { createInboxPass } from "../src/loops/verdict/pass.ts";
import { testMap } from "./support/test-database.ts";

const OWNER = "regan@example.com";
const loop = { id: "slack-loop", owner: OWNER, sources: ["slack"] } as Loop;
const mailLoop = { id: "mail-loop", owner: OWNER, sources: ["gmail"] } as Loop;
const tokens = { connectorAccessToken: async () => "synthetic-token" };
const json = (body: unknown) => Response.json(body);

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
        slack: { channelId: "D1", ts: "1762275400.000100", isDirectMessage: true, channelLabel: "DM with Josh" },
        ...overrides,
      },
      proposal: { by: "agent", data: { body: "Here is the link" } },
    },
  ]);
  return { items, item: (await items.byLoop(loop.id))[0]! };
}

interface SlackWorld {
  history: Array<Record<string, unknown>>;
  search?: Array<Record<string, unknown>>;
  pageSize?: number;
  calls?: string[];
  gone?: string;
}

function slackApi(world: SlackWorld) {
  const users: Record<string, { name: string; avatar: string }> = {
    U_JOSH: { name: "Josh", avatar: "https://avatars.example/josh.png" },
    U_REGAN: { name: "Regan", avatar: "https://avatars.example/regan.png" },
  };
  return (_token: string) => ({
    apiCall: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls?.push(method);
      if (method === "auth.test") return { ok: true, user_id: "U_REGAN", url: "https://acme.slack.com/" };
      if (method === "conversations.info") {
        const id = String(params.channel);
        return { ok: true, channel: id.startsWith("D") ? { is_im: true } : { name: "eng" } };
      }
      if (method === "users.info") {
        const user = users[String(params.user)];
        return { ok: true, user: { real_name: user?.name, profile: { image_72: user?.avatar } } };
      }
      if (world.gone && method.startsWith("conversations."))
        throw Object.assign(new Error(`An API error occurred: ${world.gone}`), {
          code: ErrorCode.PlatformError,
          data: { ok: false, error: world.gone },
        });
      if (method === "conversations.history") {
        const newestFirst = [...world.history].reverse();
        const size = world.pageSize ?? 200;
        const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const page = newestFirst.slice(start, start + size);
        const next = start + size < newestFirst.length ? String(start + size) : "";
        return { ok: true, messages: page, response_metadata: { next_cursor: next } };
      }
      if (method === "conversations.replies") {
        const root = world.history.find((m) => m.ts === params.ts);
        return { ok: true, messages: root ? [root, ...world.history.filter((m) => m.thread_ts === params.ts)] : [] };
      }
      if (method === "search.messages")
        return { ok: true, messages: { matches: world.search ?? [], paging: { pages: 1 } } };
      throw new Error(`unexpected ${method}`);
    },
  });
}

function clientsFor(world: SlackWorld, fetchImpl?: typeof fetch) {
  return createSourceClients({ tokens, slackClient: slackApi(world), ...(fetchImpl ? { fetchImpl } : {}) });
}

function scriptedModel(replies: string[], draft = "sure, it is github.com/x/y") {
  const prompts: string[] = [];
  const drafts: string[] = [];
  const model: VerdictModel = {
    verdict: async (_system, prompt) => {
      prompts.push(prompt);
      return replies.shift();
    },
    draft: async (_system, prompt) => {
      drafts.push(prompt);
      return JSON.stringify({ draft });
    },
  };
  return { model, prompts, drafts };
}

test("transcript window keeps the thread root, the last 30 messages, and everything from the owner's last message on", () => {
  const messages = Array.from({ length: 80 }, (_, i) => message(i + 1, false, `m${i + 1}`));
  const flat = transcriptWindow({ source: "slack", label: "x", messages });
  assert.equal(flat.length, 30);
  assert.equal(flat[0]!.text, "m51");
  const threaded = transcriptWindow({ source: "slack", label: "x", rootTs: "1", messages });
  assert.equal(threaded.length, 31);
  assert.equal(threaded[0]!.text, "m1");
  const ownerEarly = [...messages];
  ownerEarly[9] = message(10, true, "owner answered at 10");
  const tail = transcriptWindow({ source: "slack", label: "x", messages: ownerEarly });
  assert.equal(tail.length, 71);
  assert.equal(tail[0]!.text, "owner answered at 10");
});

test("verdict parser accepts strict JSON and rejects unknown states, missing reasons and prose", () => {
  const good = parseVerdict('```json\n{"state":"resolved","reason":"owner sent the link","waiting_ts":null}\n```');
  assert.deepEqual(good, { ok: true, verdict: { state: "resolved", reason: "owner sent the link", waitingTs: null } });
  const needs = parseVerdict('{"state":"needs_reply","reason":"open ask","waiting_ts":"1700.1"}');
  assert.deepEqual(needs, { ok: true, verdict: { state: "needs_reply", reason: "open ask", waitingTs: "1700.1" } });
  for (const bad of [
    undefined,
    "I think the owner still owes a reply.",
    '{"state":"maybe","reason":"x"}',
    '{"state":"resolved"}',
    '{"state":"needs_reply","reason":"x","waiting_ts":5}',
    '["needs_reply"]',
  ])
    assert.equal(parseVerdict(bad).ok, false, String(bad));
  const sampled = parseVerdict("not json at all");
  assert.ok(!sampled.ok && sampled.error.includes('"not json at all"'));
});

test("the fetcher reports a change only when the newest message differs from the last look", async () => {
  const { item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
      { ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" },
    ],
    calls: [],
  };
  const fetchConversation = createConversationFetcher(clientsFor(world));
  const first = await fetchConversation(OWNER, item);
  assert.equal(first.kind, "conversation");
  if (first.kind !== "conversation") return;
  assert.equal(changedSinceLastLook(item, first.conversation), true);
  const seen = { ...item, verdict: { lastSeenTs: "1762275400.000200" } as LoopItem["verdict"] };
  assert.equal(changedSinceLastLook(seen, first.conversation), false);
  world.history.push({ ts: "1762275400.000300", user: "U_JOSH", text: "Bruh" });
  const second = await fetchConversation(OWNER, item);
  assert.ok(second.kind === "conversation" && changedSinceLastLook(seen, second.conversation));
  assert.deepEqual(
    second.conversation.messages.map((m) => [m.author, m.owner]),
    [
      ["Josh", false],
      ["Regan", true],
      ["Josh", false],
    ],
  );
  assert.equal(second.conversation.externalUrl, "https://acme.slack.com/archives/D1/p1762275400000300");
  assert.deepEqual(second.conversation.participants?.map((p) => p.id).sort(), ["U_JOSH", "U_REGAN"]);
  assert.equal(world.calls!.filter((call) => call === "auth.test").length, 1);
  assert.equal(world.calls!.filter((call) => call === "users.info").length, 2);
  assert.equal(world.calls!.filter((call) => call === "conversations.info").length, 0);
});

test("Slack history pages back until the window holds 30 messages and the owner's last message", async () => {
  const { item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1.000001", user: "U_REGAN", text: "owner long ago" },
      ...Array.from({ length: 70 }, (_, i) => ({
        ts: `2.${String(i).padStart(6, "0")}`,
        user: "U_JOSH",
        text: `m${i}`,
      })),
    ],
    pageSize: 25,
    calls: [],
  };
  const outcome = await createConversationFetcher(clientsFor(world))(OWNER, item);
  assert.ok(outcome.kind === "conversation");
  assert.equal(outcome.conversation.messages.length, 71);
  assert.equal(outcome.conversation.messages[0]!.owner, true);
  assert.equal(outcome.conversation.partial, undefined);
  assert.equal(world.calls!.filter((call) => call === "conversations.history").length, 3);
  assert.equal(conversationPayload(undefined, outcome.conversation, null).sourceContextPartial, undefined);

  const deep: SlackWorld = {
    history: [
      ...Array.from({ length: 80 }, (_, i) => ({
        ts: `1.${String(i).padStart(6, "0")}`,
        user: "U_JOSH",
        text: `old${i}`,
      })),
      { ts: "2.000000", user: "U_REGAN", text: "owner" },
      ...Array.from({ length: 40 }, (_, i) => ({
        ts: `3.${String(i).padStart(6, "0")}`,
        user: "U_JOSH",
        text: `m${i}`,
      })),
    ],
    pageSize: 25,
  };
  const cut = await createConversationFetcher(clientsFor(deep))(OWNER, item);
  assert.ok(cut.kind === "conversation");
  assert.equal(cut.conversation.partial, true);
  assert.ok(cut.conversation.messages.length < deep.history.length);
  assert.equal(conversationPayload(undefined, cut.conversation, null).sourceContextPartial, true);
  const windowed = conversationPayload(
    undefined,
    {
      source: "slack",
      label: "DM",
      messages: deep.history.slice(0, 40).map((m, i) => message(i, false, String(m.text))),
    },
    null,
  );
  assert.equal((windowed.context as unknown[]).length, 30);
  assert.equal(windowed.sourceContextPartial, true);

  const threaded = await slackFixture({
    slack: { channelId: "C1", ts: "2.000003", threadTs: "2.000003", isDirectMessage: false, channelLabel: "#eng" },
  });
  const thread: SlackWorld = {
    history: [
      { ts: "2.000003", user: "U_JOSH", text: "root" },
      { ts: "2.000004", user: "U_REGAN", text: "reply", thread_ts: "2.000003" },
      { ts: "9.000000", user: "U_JOSH", text: "unrelated channel message" },
    ],
  };
  const result = await createConversationFetcher(clientsFor(thread))(OWNER, threaded.item);
  assert.ok(result.kind === "conversation");
  assert.deepEqual(
    result.conversation.messages.map((m) => m.text),
    ["root", "reply"],
  );
  assert.equal(result.conversation.rootTs, "2.000003");
  assert.equal(
    result.conversation.externalUrl,
    "https://acme.slack.com/archives/C1/p2000004?thread_ts=2.000003&cid=C1",
  );
  assert.equal(slackPermalink("", "C1", "1.1"), undefined);
});

function gmailThread() {
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  return {
    messages: [
      {
        id: "a",
        threadId: "t1",
        internalDate: "2000",
        labelIds: ["INBOX"],
        snippet: "snippet",
        payload: {
          headers: [
            { name: "From", value: "Josh <josh@example.com>" },
            { name: "To", value: "Regan <regan@example.com>, Sam <sam@example.com>" },
            { name: "Cc", value: "cc@example.com" },
            { name: "Subject", value: "Repo link?" },
            { name: "Message-ID", value: "<a@mail>" },
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
  };
}

async function gmailFixture() {
  const items = createLoopItemLedger(testMap());
  await items.ingest([
    {
      loopId: mailLoop.id,
      dedupeKey: "t1",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { title: "Hello", snippet: "hi", gmail: { threadId: "t1", accountType: "personal" } },
    },
  ]);
  return { items, item: (await items.byLoop(mailLoop.id))[0]! };
}

const gmailFetch: typeof fetch = async (url) => {
  const path = String(url);
  if (path.endsWith("/profile")) return json({ emailAddress: "Regan@Example.com" });
  if (/threads\?/.test(path)) return json({ threads: [{ id: "t1" }, { id: "t2" }] });
  assert.match(path, /threads\/t1\?format=full$/);
  return json(gmailThread());
};

test("Gmail threads mark SENT messages as the owner's, drop drafts, decode bodies and compute reply recipients", async () => {
  const { item } = await gmailFixture();
  const outcome = await createConversationFetcher(clientsFor({ history: [] }, gmailFetch))(OWNER, item);
  assert.ok(outcome.kind === "conversation");
  const { conversation } = outcome;
  assert.equal(conversation.label, "Repo link?");
  assert.equal(conversation.externalUrl, "https://mail.google.com/mail/u/regan%40example.com/#inbox/t1");
  assert.deepEqual(
    conversation.messages.map((m) => [m.ts, m.owner, m.text]),
    [
      ["2000", false, "Can you send the repo link?"],
      ["3000", true, "Here you go"],
    ],
  );
  assert.deepEqual(conversation.messages[0]!.reply, {
    messageId: "a",
    rfcMessageId: "<a@mail>",
    to: ["Josh <josh@example.com>", "Sam <sam@example.com>"],
    cc: ["cc@example.com"],
  });
  assert.equal(conversation.messages[1]!.reply, undefined);
});

test("the payload builder keeps send metadata and previews the waiting message", async () => {
  const { item } = await gmailFixture();
  const outcome = await createConversationFetcher(clientsFor({ history: [] }, gmailFetch))(OWNER, item);
  assert.ok(outcome.kind === "conversation");
  const payload = conversationPayload(item.sourcePayload, outcome.conversation, "2000");
  assert.equal(payload.title, "Repo link?");
  assert.equal(payload.from, "Josh");
  assert.equal(payload.fromDetail, "josh@example.com");
  assert.equal(payload.snippet, "Can you send the repo link?");
  assert.equal(payload.receivedAt, 3000);
  assert.deepEqual(payload.gmail, {
    threadId: "t1",
    accountType: "personal",
    subject: "Repo link?",
    accountEmail: "regan@example.com",
    messageId: "a",
    rfcMessageId: "<a@mail>",
    to: ["Josh <josh@example.com>", "Sam <sam@example.com>"],
    cc: ["cc@example.com"],
  });
  assert.equal((payload.context as unknown[]).length, 2);
  const resolved = conversationPayload(item.sourcePayload, outcome.conversation, null);
  assert.equal(resolved.snippet, "Can you send the repo link?");
});

test("the pass stores the verdict and transcript, leaves human state alone, and only re-runs on change", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
      { ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" },
      { ts: "1762275400.000300", user: "U_JOSH", text: "Bruh" },
    ],
  };
  const { model, prompts } = scriptedModel(['{"state":"resolved","reason":"owner sent the link","waiting_ts":null}']);
  const clients = clientsFor(world);
  const pass = createInboxPass({
    items,
    model,
    fetch: createConversationFetcher(clients),
    discover: async () => [],
    ownerName: async () => "Regan",
    now: () => 5_000_000,
  });
  const summary = await pass(loop, { discover: false });
  assert.deepEqual(summary, { discovered: 0, checked: 1, verdicts: 1, failures: [], scanned: false });
  const after = (await items.get(item.id))!;
  assert.equal(after.status, "ready");
  assert.equal(after.proposal, undefined);
  assert.deepEqual(after.verdict, {
    state: "resolved",
    reason: "owner sent the link",
    waitingTs: null,
    lastSeenTs: "1762275400.000300",
    at: 5_000_000,
  });
  assert.equal(after.sourceAt, 1_762_275_400_000);
  assert.equal(after.sourcePayload?.snippet, "Bruh");
  assert.equal(after.sourcePayload?.title, "DM with Josh");
  const payload = after.sourcePayload!;
  assert.equal((payload.context as unknown[]).length, 3);
  assert.deepEqual((payload.participants as Array<{ id: string }>).map((p) => p.id).sort(), ["U_JOSH", "U_REGAN"]);
  assert.match(prompts[0]!, /Owner: Regan \(regan@example.com\)/);
  assert.match(prompts[0]!, /owner \(Regan\): github.com\/x\/y/);
  assert.match(prompts[0]!, /Owner's unsent draft from an earlier look: "Here is the link"/);

  await pass(loop, { discover: false });
  assert.equal(prompts.length, 1);
});

test("a textless message after the owner's answer still gets a fresh verdict and a draft on needs_reply", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
      { ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" },
      {
        ts: "1762275400.000300",
        user: "U_JOSH",
        text: "",
        files: [{ id: "F1", mimetype: "image/png", url_private: "https://files.slack.com/F1" }],
      },
    ],
  };
  const { model, prompts, drafts } = scriptedModel([
    '{"state":"needs_reply","reason":"screenshot shows an error to fix","waiting_ts":"1762275400.000300"}',
  ]);
  await createInboxPass({
    items,
    model,
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [],
  })(loop, { discover: false });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Josh: \(no text\) \[1 attachment\]/);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0]!, /Waiting message: ts=1762275400.000300/);
  const after = (await items.get(item.id))!;
  assert.equal(after.verdict?.state, "needs_reply");
  assert.equal(after.proposal?.by, "agent");
  assert.equal(after.proposal?.data.body, "sure, it is github.com/x/y");
  assert.equal(after.sourcePayload?.snippet, "Sent an image");
  assert.deepEqual(after.sourcePayload?.images, ["https://files.slack.com/F1"]);
  assert.equal((after.sourcePayload!.slack as { ts: string }).ts, "1762275400.000300");
});

test("a sent item stays handled when only the owner's own messages arrived since the last look", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
      { ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" },
    ],
  };
  const { model, prompts } = scriptedModel([
    '{"state":"needs_reply","reason":"open ask","waiting_ts":"1762275400.000100"}',
    '{"state":"resolved","reason":"owner answered","waiting_ts":null}',
  ]);
  const pass = createInboxPass({
    items,
    model,
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [{ loopId: loop.id, dedupeKey: "D1", source: "slack", sourcePayload: { title: "DM" } }],
  });
  world.history.pop();
  await pass(loop, { discover: true });
  await items.recordAction(item.id, { kind: "send", outcome: "actioned", result: "github.com/x/y" });
  world.history.push({ ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" });
  await pass(loop, { discover: true });
  assert.equal(prompts.length, 1);
  assert.equal((await items.get(item.id))!.status, "shipped");
  world.history.push({ ts: "1762275400.000300", user: "U_JOSH", text: "thanks!" });
  await pass(loop, { discover: true });
  assert.equal(prompts.length, 2);
  const after = (await items.get(item.id))!;
  assert.equal(after.status, "shipped");
  assert.equal(after.verdict?.state, "resolved");
});

test("a conversation the owner answered in the source lands in Handled as replied and reopens only on a new ask", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
      { ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" },
    ],
  };
  const { model } = scriptedModel([
    '{"state":"resolved","reason":"owner answered","waiting_ts":null}',
    '{"state":"resolved","reason":"just thanks","waiting_ts":null}',
    '{"state":"needs_reply","reason":"new ask","waiting_ts":"1762275400.000400"}',
  ]);
  const pass = createInboxPass({
    items,
    model,
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [{ loopId: loop.id, dedupeKey: "D1", source: "slack", sourcePayload: { title: "DM" } }],
  });
  await pass(loop, { discover: true });
  const replied = (await items.get(item.id))!;
  assert.equal(replied.status, "skipped");
  assert.equal(replied.actionKind, "replied");
  assert.equal(replied.actionResult, "github.com/x/y");
  assert.equal(replied.verdict?.state, "resolved");
  assert.equal(replied.proposal, undefined);

  world.history.push({ ts: "1762275400.000300", user: "U_JOSH", text: "thanks!" });
  await pass(loop, { discover: true });
  assert.equal((await items.get(item.id))!.status, "skipped");

  world.history.push({ ts: "1762275400.000400", user: "U_JOSH", text: "also, can you review my PR?" });
  await pass(loop, { discover: true });
  const reopened = (await items.get(item.id))!;
  assert.equal(reopened.status, "ready");
  assert.equal(reopened.actionKind, undefined);
  assert.equal(reopened.verdict?.state, "needs_reply");
  assert.equal(reopened.sourcePayload?.snippet, "also, can you review my PR?");
});

test("a resolved conversation whose newest message is not the owner's stays open as probably resolved", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = {
    history: [
      { ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" },
      { ts: "1762275400.000200", user: "U_REGAN", text: "github.com/x/y" },
      { ts: "1762275400.000300", user: "U_JOSH", text: "thanks!" },
    ],
  };
  const { model } = scriptedModel(['{"state":"resolved","reason":"owner answered","waiting_ts":null}']);
  const pass = createInboxPass({
    items,
    model,
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [],
  });
  await pass(loop, { discover: true });
  const after = (await items.get(item.id))!;
  assert.equal(after.status, "ready");
  assert.equal(after.actionKind, undefined);
  assert.equal(after.verdict?.state, "resolved");
});

test("discovery ingests new Slack DMs and mentions and Gmail threads, keyed like the source adapters", async () => {
  const items = createLoopItemLedger(testMap());
  const world: SlackWorld = {
    history: [],
    search: [
      {
        ts: "1762275400.000001",
        user: "U_JOSH",
        channel: { id: "D1" },
        permalink: "https://acme.slack.com/archives/D1/p1762275400000001",
      },
      { ts: "1762275400.000002", user: "U_REGAN", channel: { id: "D1" } },
      {
        ts: "1762275400.000003",
        user: "U_JOSH",
        channel: { id: "C1" },
        permalink: "https://acme.slack.com/archives/C1/p1762275400000003?thread_ts=1762275300.000001&cid=C1",
      },
      { ts: "1762275400.000004", user: "U_JOSH", channel: { id: "C1" } },
      { ts: "1.000001", user: "U_JOSH", channel: { id: "D9" } },
    ],
  };
  const clients = clientsFor(world, gmailFetch);
  const discover = createDiscoverer(clients);
  const since = 1_000_000_000_000;
  const found = await discover(loop, since);
  assert.deepEqual(
    found.map((entry) => [entry.dedupeKey, (entry.sourcePayload.slack as { threadTs?: string }).threadTs]).sort(),
    [
      ["C1:1762275300.000001", "1762275300.000001"],
      ["C1:1762275400.000004", "1762275400.000004"],
      ["D1", undefined],
    ],
  );
  assert.equal(found.find((entry) => entry.dedupeKey === "D1")?.sourcePayload.title, "Slack conversation");
  assert.equal(found.find((entry) => entry.dedupeKey === "C1:1762275400.000004")?.sourcePayload.title, "#eng");
  const mail = await discover(mailLoop, since);
  assert.deepEqual(
    mail.map((entry) => entry.dedupeKey),
    ["t1", "t2"],
  );
  assert.equal(scanSince({ lastScanAt: 10_000_000 }), 10_000_000 - 30 * 60 * 1000);
  assert.equal(scanSince({}, 1_000_000_000), 1_000_000_000 - 3 * 24 * 60 * 60 * 1000);

  await items.ingest([found[0]!]);
  const { model } = scriptedModel([]);
  const summary = await createInboxPass({
    items,
    model,
    fetch: async () => ({ kind: "skipped", reason: "not_connected" }),
    discover: async () => found,
  })(loop, { discover: true });
  assert.equal(summary.discovered, 2);
  assert.equal((await items.byLoop(loop.id)).length, 3);
});

test("a scheduled pass reads only conversations with activity, stubs, and channel threads", async () => {
  const items = createLoopItemLedger(testMap());
  const slackMeta = (channelId: string, extra: Record<string, unknown> = {}) => ({
    channelId,
    ts: "1762275400.000100",
    isDirectMessage: true,
    channelLabel: "DM",
    ...extra,
  });
  await items.ingest([
    {
      loopId: loop.id,
      dedupeKey: "quiet",
      source: "slack",
      sourceAt: 1,
      sourcePayload: { title: "quiet", slack: slackMeta("D_QUIET") },
    },
    {
      loopId: loop.id,
      dedupeKey: "active",
      source: "slack",
      sourceAt: 1,
      sourcePayload: { title: "active", slack: slackMeta("D_ACTIVE") },
    },
    {
      loopId: loop.id,
      dedupeKey: "stub",
      source: "slack",
      sourceAt: 1,
      sourcePayload: { title: "stub", slack: slackMeta("D_STUB") },
    },
    {
      loopId: loop.id,
      dedupeKey: "C1:1.1",
      source: "slack",
      sourceAt: 1,
      sourcePayload: {
        title: "#eng",
        slack: { channelId: "C1", ts: "1.1", threadTs: "1.1", isDirectMessage: false, channelLabel: "#eng" },
      },
    },
  ]);
  const verdict = { state: "resolved" as const, reason: "seen", waitingTs: null, lastSeenTs: "x", at: 1 };
  for (const key of ["quiet", "active", "C1:1.1"]) {
    const item = (await items.byLoop(loop.id)).find((row) => row.sourceKey === key)!;
    await items.recordVerdict(item.id, { verdict, sourcePayload: item.sourcePayload!, sourceAt: 1 });
  }
  const fetched: string[] = [];
  const fetchConversation = async (_owner: string, item: LoopItem) => {
    fetched.push(item.sourceKey);
    return { kind: "skipped" as const, reason: "not_connected" as const };
  };
  const { model } = scriptedModel([]);
  let discoverFails = false;
  const pass = createInboxPass({
    items,
    model,
    fetch: fetchConversation,
    discover: async () => {
      if (discoverFails) throw new Error("search is down");
      return [{ loopId: loop.id, dedupeKey: "active", source: "slack", sourcePayload: { title: "active" } }];
    },
  });
  const scheduled = await pass(loop, { discover: true });
  assert.equal(scheduled.scanned, true);
  assert.deepEqual(fetched.sort(), ["C1:1.1", "active", "stub"]);

  fetched.length = 0;
  const itemOnly = await pass(loop, { discover: false });
  assert.equal(itemOnly.scanned, false);
  assert.deepEqual(fetched.sort(), ["C1:1.1", "stub"]);

  fetched.length = 0;
  discoverFails = true;
  const blind = await pass(loop, { discover: true });
  assert.equal(blind.scanned, false);
  assert.deepEqual(blind.failures, ["search is down"]);
  assert.deepEqual(fetched.sort(), ["C1:1.1", "active", "quiet", "stub"]);
});

test("the pass skips items without a usable source reference and logs model failures without throwing", async () => {
  const items = createLoopItemLedger(testMap());
  await items.ingest([
    { loopId: loop.id, dedupeKey: "broken", source: "slack", sourceAt: 1, sourcePayload: { title: "no meta" } },
  ]);
  const { item } = await slackFixture().then(async (fixture) => {
    await items.ingest([
      {
        loopId: loop.id,
        dedupeKey: "D1",
        source: "slack",
        sourceAt: 1_000_000,
        sourcePayload: fixture.item.sourcePayload!,
      },
    ]);
    return { item: (await items.byLoop(loop.id)).find((row) => row.sourceKey === "D1")! };
  });
  const world: SlackWorld = {
    history: [{ ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" }],
  };
  const { model, prompts } = scriptedModel(["not json at all"]);
  const errors: Array<{ code: string; message: string }> = [];
  const summary = await createInboxPass({
    items,
    model,
    errors: { record: (event: { code: string; message: string }) => void errors.push(event) },
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [],
  })(loop, { discover: false });
  assert.equal(prompts.length, 1);
  assert.equal(summary.checked, 2);
  assert.equal(summary.verdicts, 0);
  assert.deepEqual(summary.failures, ['verdict was not a JSON object: "not json at all"']);
  assert.equal((await items.get(item.id))!.verdict, undefined);
  const broken = (await items.byLoop(loop.id)).find((row) => row.sourceKey === "broken")!;
  assert.equal(broken.status, "skipped");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "verdict_failed");
});

test("a failed draft keeps the verdict and records the model's reply in the error log", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = {
    history: [{ ts: "1762275400.000100", user: "U_JOSH", text: "Do you have a link to the repo?" }],
  };
  const errors: Array<{ code: string; message: string }> = [];
  const model: VerdictModel = {
    verdict: async () => '{"state":"needs_reply","reason":"open ask","waiting_ts":"1762275400.000100"}',
    draft: async () => "Sure thing, here you go",
  };
  await createInboxPass({
    items,
    model,
    errors: { record: (event: { code: string; message: string }) => void errors.push(event) },
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [],
  })(loop, { discover: false });
  const after = (await items.get(item.id))!;
  assert.equal(after.verdict?.state, "needs_reply");
  assert.equal(after.proposal, undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "draft_failed");
  assert.match(errors[0]!.message, /draft was not \{"draft": string\}: "Sure thing, here you go"/);
});

test("long message bodies are cut with a visible marker instead of silently", () => {
  const conversation: Conversation = {
    source: "gmail",
    label: "Email thread",
    messages: [message(1, false, "x".repeat(3500))],
  };
  const prompt = renderVerdictPrompt({ owner: { id: OWNER }, conversation, now: 0 });
  assert.match(prompt, /x{3000} \[cut 500 chars\]/);
  assert.doesNotMatch(prompt, /x{3001}/);
  assert.match(prompt, /Conversation: Email thread/);
});

test("a deleted or unreadable source skips the item without an error and stops re-reading it", async () => {
  const { items, item } = await slackFixture();
  const world: SlackWorld = { history: [], gone: "channel_not_found", calls: [] };
  const { model, prompts } = scriptedModel([]);
  const errors: unknown[] = [];
  const pass = createInboxPass({
    items,
    model,
    errors: { record: (event: unknown) => void errors.push(event) },
    fetch: createConversationFetcher(clientsFor(world)),
    discover: async () => [],
  });
  const summary = await pass(loop, { discover: false });
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(errors, []);
  assert.equal(prompts.length, 0);
  const after = (await items.get(item.id))!;
  assert.equal(after.status, "skipped");
  assert.equal(
    after.parkedReason,
    "the original conversation was deleted or is no longer accessible (Slack channel_not_found)",
  );
  world.calls!.length = 0;
  assert.equal((await pass(loop, { discover: false })).checked, 0);
  assert.deepEqual(world.calls, []);

  world.gone = "invalid_auth";
  await assert.rejects(createConversationFetcher(clientsFor(world))(OWNER, item), /invalid_auth/);
});

test("Gmail reads the item's own mailbox and treats a missing thread as gone", async () => {
  const requested: Array<string | undefined> = [];
  const accountTokens = {
    connectorAccessToken: async (_host: string, _owner: string, slot?: string) => {
      requested.push(slot);
      return slot === "company" ? "company-token" : "personal-token";
    },
  };
  const items = createLoopItemLedger(testMap());
  await items.ingest([
    {
      loopId: mailLoop.id,
      dedupeKey: "t1",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { title: "Hello", gmail: { threadId: "t1", accountType: "company" } },
    },
  ]);
  const item = (await items.byLoop(mailLoop.id))[0]!;
  const seen: string[] = [];
  const missing: typeof fetch = async (url, init) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    if (String(url).endsWith("/profile")) return json({ emailAddress: "regan@company.example" });
    return Response.json({ error: { code: 404, message: "Requested entity was not found." } }, { status: 404 });
  };
  const fetcher = createConversationFetcher(createSourceClients({ tokens: accountTokens, fetchImpl: missing }));
  assert.deepEqual(await fetcher(OWNER, item), {
    kind: "skipped",
    reason: "source_gone",
    detail: "Gmail threads/t1 returned 404 for the company account",
  });
  assert.deepEqual(requested, ["company"]);
  assert.ok(seen.every((header) => header === "Bearer company-token"));
});
