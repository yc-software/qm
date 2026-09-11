import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopItem, LoopSourcePayload } from "../src/types.ts";
import type { ConnectorTokenSource, SlackUserClient } from "../src/loops/sources/adapter.ts";
import { buildGmailReplyMime, gmailAdapter, replySubject } from "../src/loops/sources/gmail.ts";
import { renderSlackSendText, slackAdapter, slackReplyThreadTs } from "../src/loops/sources/slack.ts";
import { SLACK_POST_SPLIT_LIMIT } from "../src/slack/delivery.ts";
import { adapterForItem } from "../src/loops/sources/index.ts";

function item(source: string, payload: Record<string, unknown>, proposal?: Record<string, unknown>): LoopItem {
  return {
    id: "i1",
    loopId: "l1",
    sourceKey: "t1",
    source,
    sourcePayload: { source, title: "Quarterly numbers", from: "Ada", snippet: "…", receivedAt: 1, ...payload },
    sourceAt: 1,
    status: proposal ? "ready" : "queued",
    attempts: 0,
    runIds: [],
    outputIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...(proposal ? { proposal: { data: proposal, by: "agent" as const, at: 1 } } : {}),
  };
}

const gmailItem = item("gmail", {
  gmail: { threadId: "t1", rfcMessageId: "<msg-1@mail>", subject: "Quarterly numbers", to: ["ada@example.com"] },
});

const slackItem = item("slack", { slack: { channelId: "C1", ts: "111.222" } });

function tokens(map: Record<string, string | null>): ConnectorTokenSource {
  return {
    connectorAccessToken: async (host, _principal, accountType) =>
      accountType === "personal" ? (map[host] ?? null) : null,
  };
}

interface SlackCall {
  api: "chat.postMessage" | "reactions.add";
  args: Record<string, unknown>;
  token: string;
}

function slackSpy(fail?: string): { calls: SlackCall[]; factory: (token: string) => SlackUserClient } {
  const calls: SlackCall[] = [];
  const record = (api: SlackCall["api"], token: string) => async (args: Record<string, unknown>) => {
    calls.push({ api, args, token });
    if (fail) throw Object.assign(new Error(`An API error occurred: ${fail}`), { data: { ok: false, error: fail } });
    return { ok: true };
  };
  return {
    calls,
    factory: (token) => ({
      chat: { postMessage: record("chat.postMessage", token) },
      reactions: { add: record("reactions.add", token) },
    }),
  };
}

test("gmail reply MIME threads correctly and survives a UTF-8 body", () => {
  const mime = buildGmailReplyMime(gmailItem, { body: "Confirmed — see attached. ✅" })!;
  assert.match(mime, /^To: ada@example\.com\r\n/);
  assert.match(mime, /Subject: Re: Quarterly numbers\r\n/);
  assert.match(mime, /In-Reply-To: <msg-1@mail>\r\n/);
  assert.match(mime, /References: <msg-1@mail>\r\n/);
  const body = mime.split("\r\n\r\n")[1]!;
  assert.equal(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8"), "Confirmed — see attached. ✅");
});

test("subjects keep an existing Re: and non-ASCII subjects get RFC 2047 encoding", () => {
  assert.equal(
    replySubject(item("gmail", { gmail: { threadId: "t", subject: "RE: hello" } }), { body: "x" }),
    "RE: hello",
  );
  assert.equal(replySubject(gmailItem, { body: "x", subject: "Override" }), "Override");
  const mime = buildGmailReplyMime(item("gmail", { gmail: { threadId: "t", subject: "café plans", to: ["a@b.c"] } }), {
    body: "x",
  })!;
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
});

test("a gmail item with no recipient anywhere refuses to send", async () => {
  const result = await gmailAdapter.act(
    { owner: "josh", tokens: tokens({ "gmail.googleapis.com": "tok" }) },
    item("gmail", { gmail: { threadId: "t1" } }),
    "send",
    { body: "hello" },
  );
  assert.deepEqual(result, { ok: false, reason: "bad_item", message: "no recipient — add a To: address to the draft" });
});

test("gmail send posts base64url raw with the thread id", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ id: "m2" }), { status: 200 });
  }) as typeof fetch;
  const result = await gmailAdapter.act(
    { owner: "josh", tokens: tokens({ "gmail.googleapis.com": "tok-g" }), fetchImpl },
    gmailItem,
    "send",
    { body: "Confirmed." },
  );
  assert.deepEqual(result, { ok: true, result: "Confirmed." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tok-g");
  const body = JSON.parse(String(calls[0]!.init.body)) as { raw: string; threadId: string };
  assert.equal(body.threadId, "t1");
  assert.doesNotMatch(body.raw, /[+/=]/);
});

test("the held proposal is what goes out when the action carries no draft", async () => {
  let sent = "";
  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw;
    sent = Buffer.from(raw, "base64url").toString("utf8");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const held = item(
    "gmail",
    { gmail: { threadId: "t1", to: ["ada@example.com"], subject: "Quarterly numbers" } },
    { body: "the held draft" },
  );
  const result = await gmailAdapter.act(
    { owner: "josh", tokens: tokens({ "gmail.googleapis.com": "tok" }), fetchImpl },
    held,
    "send",
    {},
  );
  assert.equal(result.ok, true);
  const encoded = sent.split("\r\n\r\n")[1]!;
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "the held draft");
});

test("a missing connector reads as not_connected, not an exception", async () => {
  const result = await gmailAdapter.act({ owner: "josh", tokens: tokens({}) }, gmailItem, "send", { body: "x" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_connected");
  const slackResult = await slackAdapter.act({ owner: "josh", tokens: tokens({}) }, slackItem, "send", { body: "x" });
  assert.equal(slackResult.ok, false);
  if (!slackResult.ok) assert.equal(slackResult.reason, "not_connected");
});

test("slack replies thread on channel messages and stay inline in DMs", () => {
  assert.equal(slackReplyThreadTs(slackItem), "111.222");
  assert.equal(slackReplyThreadTs(item("slack", { slack: { channelId: "D9", ts: "3.4" } })), undefined);
  assert.equal(slackReplyThreadTs(item("slack", { slack: { channelId: "D9", ts: "3.4", threadTs: "1.2" } })), "1.2");
});

test("slack send posts as the user through the slack client", async () => {
  const spy = slackSpy();
  const ok = await slackAdapter.act(
    { owner: "josh", tokens: tokens({ "slack.com": "xoxp-1" }), slackClient: spy.factory },
    slackItem,
    "send",
    { body: "on it" },
  );
  assert.deepEqual(ok, { ok: true, result: "on it" });
  assert.equal(spy.calls[0]!.api, "chat.postMessage");
  assert.equal(spy.calls[0]!.token, "xoxp-1");
  assert.deepEqual(spy.calls[0]!.args, { channel: "C1", text: "on it", parse: "none", thread_ts: "111.222" });
});

test("a slack-level refusal surfaces its error code rather than an opaque failure", async () => {
  const spy = slackSpy("not_in_channel");
  const bad = await slackAdapter.act(
    { owner: "josh", tokens: tokens({ "slack.com": "x" }), slackClient: spy.factory },
    slackItem,
    "send",
    { body: "on it" },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.reason, "upstream");
    assert.match(bad.message, /not_in_channel/);
  }
});

test("react adds the emoji in slack and annotates the item without closing it", async () => {
  const spy = slackSpy();
  const deps = { owner: "josh", tokens: tokens({ "slack.com": "xoxp-1" }), slackClient: spy.factory };
  const first = await slackAdapter.act(deps, slackItem, "react", { name: ":eyes:" });
  assert.deepEqual(first, { ok: true, result: ":eyes:", resolves: false, payloadPatch: { reactions: ["eyes"] } });
  assert.equal(spy.calls[0]!.api, "reactions.add");
  assert.deepEqual(spy.calls[0]!.args, { channel: "C1", timestamp: "111.222", name: "eyes" });
  const already = item("slack", { slack: { channelId: "C1", ts: "111.222" }, reactions: ["eyes"] });
  const second = await slackAdapter.act(deps, already, "react", { name: "tada" });
  assert.equal(second.ok, true);
  if (second.ok) assert.deepEqual(second.payloadPatch, { reactions: ["eyes", "tada"] });
});

test("react accepts a raw emoji character and refuses a name it cannot resolve", async () => {
  const spy = slackSpy();
  const deps = { owner: "josh", tokens: tokens({ "slack.com": "x" }), slackClient: spy.factory };
  const fromChar = await slackAdapter.act(deps, slackItem, "react", { name: "\u{1F440}" });
  assert.equal(fromChar.ok, true);
  if (fromChar.ok) assert.equal(fromChar.result, ":eyes:");
  const nameless = await slackAdapter.act(deps, slackItem, "react", {});
  assert.equal(nameless.ok, false);
  if (!nameless.ok) assert.equal(nameless.reason, "bad_item");
});

test("a reaction slack refuses reads as an upstream failure", async () => {
  const spy = slackSpy("restricted_action");
  const out = await slackAdapter.act(
    { owner: "josh", tokens: tokens({ "slack.com": "x" }), slackClient: spy.factory },
    slackItem,
    "react",
    { name: "eyes" },
  );
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "upstream");
});

test("reacting with no connected slack account reads as not_connected", async () => {
  const out = await slackAdapter.act({ owner: "josh", tokens: tokens({}) }, slackItem, "react", { name: "eyes" });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "not_connected");
});

test("an empty draft never leaves the house", async () => {
  const result = await slackAdapter.act({ owner: "josh", tokens: tokens({ "slack.com": "x" }) }, slackItem, "send", {
    body: "   ",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_item");
});

test("an unknown action kind is refused rather than guessed at", async () => {
  const result = await slackAdapter.act({ owner: "josh", tokens: tokens({ "slack.com": "x" }) }, slackItem, "publish", {
    body: "hi",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /publish/);
  assert.deepEqual([...slackAdapter.actions], ["send", "react"]);
});

test("adapters parse their own source shape into an opaque payload", () => {
  const parsed = gmailAdapter.parse({
    source: "gmail",
    sourceKey: "thread-9",
    title: "Budget",
    from: "Ada",
    snippet: "thoughts?",
    receivedAt: 1700,
    gmail: { threadId: "thread-9", to: ["ada@example.com"] },
    draft: { body: "sure", to: ["ada@example.com"] },
  });
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.dedupeKey, "thread-9");
  assert.equal(parsed.sourceAt, 1700);
  assert.equal(parsed.sourcePayload.source, "gmail");
  assert.deepEqual(parsed.proposal?.data, { body: "sure", to: ["ada@example.com"] });
});

test("adapters reject items missing the fields their send path needs", () => {
  assert.deepEqual(
    gmailAdapter.parse({ source: "gmail", sourceKey: "k", title: "t", from: "f", snippet: "s", receivedAt: 1 }),
    {
      error: "gmail items need gmail.threadId",
    },
  );
  assert.deepEqual(
    slackAdapter.parse({ source: "slack", sourceKey: "k", title: "t", from: "f", snippet: "s", receivedAt: 1 }),
    { error: "slack items need slack.channelId and slack.ts" },
  );
  assert.deepEqual(slackAdapter.parse({ source: "slack", title: "t" }), { error: "from required" });
});

test("an item resolves to the adapter that owns its source", () => {
  assert.equal(adapterForItem(gmailItem)?.id, "gmail");
  assert.equal(adapterForItem(slackItem)?.id, "slack");
  assert.equal(adapterForItem(item("sentry", {})), undefined);
});

const agentDraft = "Hi <@U7|ada>, see <!here> and <!subteam^S1|@eng>: **done** — `x`";
const slackMeta = { slack: { channelId: "C1", ts: "1.1" } };

test("an untouched agent draft goes out as written, with every mention disarmed", () => {
  const held = item("slack", slackMeta, { body: agentDraft });
  assert.equal(renderSlackSendText(held, agentDraft), "Hi @ada, see @\u200bhere and @eng: **done** — `x`");
  const native = item("slack", slackMeta, { body: "*bold* and _quiet_ <!channel>" });
  assert.equal(
    renderSlackSendText(native, "*bold* and _quiet_ <!channel>"),
    "*bold* and _quiet_ @\u200bchannel",
    "Slack-native formatting is never re-interpreted as markdown",
  );
});

test("a human-edited body goes out verbatim, except mentions carried over from the agent draft", () => {
  const held = item("slack", slackMeta, { body: agentDraft });
  const edited = "Team <!here> please read; also <!channel> and <@U7> plus <@U9|bob> **bold**";
  assert.equal(
    renderSlackSendText(held, edited),
    "Team @\u200bhere please read; also <!channel> and @U7 plus <@U9|bob> **bold**",
  );
});

test("a draft the human wrote from scratch is never rewritten", () => {
  assert.equal(renderSlackSendText(item("slack", slackMeta), "Ping <!here> **bold**"), "Ping <!here> **bold**");
});

test("every agent draft the item ever had contributes to the disarm set, even after a redraft", () => {
  const held = item("slack", slackMeta, { body: "human words <!channel>" });
  held.proposal!.by = "human";
  held.agentDrafts = [
    { data: { body: "first draft <!channel>" } as unknown as LoopSourcePayload, by: "agent", at: 0 },
    { data: { body: "calmer second draft" } as unknown as LoopSourcePayload, by: "agent", at: 1 },
  ];
  assert.equal(renderSlackSendText(held, "human words <!channel>"), "human words @\u200bchannel");
  assert.equal(renderSlackSendText(held, "calmer second draft"), "calmer second draft");
});

test("an agent posting through the API and an item with unknown provenance get every mention disarmed", () => {
  const fresh = item("slack", slackMeta, { body: "x" });
  assert.equal(renderSlackSendText(fresh, "go <!here> <@U9>", "agent"), "go @\u200bhere @U9");
  const legacy = item("slack", slackMeta, { body: "edited before deploy <!here>" });
  legacy.proposal!.by = "human";
  delete legacy.agentDrafts;
  assert.equal(renderSlackSendText(legacy, "edited before deploy <!here>"), "edited before deploy @\u200bhere");
  const scratch = item("slack", slackMeta);
  scratch.agentDrafts = [];
  assert.equal(renderSlackSendText(scratch, "mine <!here>"), "mine <!here>", "a person's own item stays live");
});

test("a long send is posted as fence-safe parts and the record is what actually went out", async () => {
  const spy = slackSpy();
  const body = `intro\n\`\`\`\n${"line of code\n".repeat(400)}\`\`\`\nafter`;
  const out = await slackAdapter.act(
    { owner: "josh", tokens: tokens({ "slack.com": "xoxp" }), slackClient: spy.factory },
    item("slack", slackMeta),
    "send",
    { body } as unknown as LoopSourcePayload,
  );
  assert.equal(out.ok, true);
  const texts = spy.calls.map((c) => c.args.text as string);
  assert.ok(texts.length > 1, "the body exceeded one Slack message");
  for (const t of texts) assert.ok(t.length <= SLACK_POST_SPLIT_LIMIT);
  assert.equal(out.ok && out.result, texts.join("\n"));
});

test("a part Slack refuses mid-way reports how much landed instead of pretending success", async () => {
  let n = 0;
  const failing: SlackUserClient = {
    chat: {
      postMessage: async () => {
        if (++n === 2) throw Object.assign(new Error("ratelimited"), { data: { ok: false, error: "ratelimited" } });
        return { ok: true, ts: String(n) };
      },
    },
    reactions: { add: async () => ({ ok: true }) },
  } as unknown as SlackUserClient;
  const out = await slackAdapter.act(
    { owner: "josh", tokens: tokens({ "slack.com": "xoxp" }), slackClient: () => failing },
    item("slack", slackMeta),
    "send",
    { body: "x".repeat(SLACK_POST_SPLIT_LIMIT * 2 + 10) } as unknown as LoopSourcePayload,
  );
  assert.equal(out.ok, false);
  assert.equal(out.ok ? undefined : out.partial, true);
  assert.match(out.ok ? "" : out.message, /posted 1 of 3 parts.*ratelimited/);
});

test("a mention that fell out of the bounded draft history is still disarmed through the kept identities", () => {
  const held = item("slack", slackMeta, { body: "human kept <!here>" });
  held.proposal!.by = "human";
  held.agentDrafts = [{ data: { body: "calm v11" } as unknown as LoopSourcePayload, by: "agent", at: 11 }];
  held.agentMentionKeys = ["!here"];
  assert.equal(renderSlackSendText(held, "human kept <!here>"), "human kept @\u200bhere");
});
