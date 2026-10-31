import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationFor,
  deliveryTargetFor,
  routeMessage,
  threadName,
  type DiscordInbound,
} from "../src/discord/events.ts";

const BOT_ID = "999";
const BOT = { id: BOT_ID, name: "qm" };
const GUILDS = new Set(["900"]);
const msg = (over: Partial<DiscordInbound>): DiscordInbound => ({
  id: "m1",
  channelId: "c1",
  guildId: null,
  threadParentId: null,
  channelName: null,
  authorId: "111",
  authorName: "Ana",
  authorIsBot: false,
  content: "hi",
  mentionedUserIds: [],
  attachments: [],
  ...over,
});

test("DMs route to the DM session", () => {
  assert.deepEqual(routeMessage(msg({}), BOT, GUILDS), { target: "dm", text: "hi" });
});

test("a mention in a configured guild channel opens a thread and the mention stays as the bot handle", () => {
  const r = routeMessage(msg({ guildId: "900", content: "<@999> deploy it", mentionedUserIds: [BOT_ID] }), BOT, GUILDS);
  assert.deepEqual(r, { target: "new-thread", text: "@qm deploy it", title: "deploy it" });
});

test("an unmentioned top-level guild message is ignored", () => {
  assert.equal(routeMessage(msg({ guildId: "900" }), BOT, GUILDS), null);
});

test("guilds that are not configured are ignored", () => {
  assert.equal(routeMessage(msg({ guildId: "901", mentionedUserIds: [BOT_ID] }), BOT, GUILDS), null);
});

test("inside a thread a mention is prompted and anything else is an ambient candidate", () => {
  const inThread = { guildId: "900", channelId: "t1", threadParentId: "c1" };
  assert.deepEqual(
    routeMessage(msg({ ...inThread, content: "<@!999> again", mentionedUserIds: [BOT_ID] }), BOT, GUILDS),
    {
      target: "thread",
      text: "@qm again",
      unprompted: false,
    },
  );
  assert.deepEqual(routeMessage(msg({ ...inThread, content: "and also" }), BOT, GUILDS), {
    target: "thread",
    text: "and also",
    unprompted: true,
  });
});

test("this bot is ignored everywhere", () => {
  assert.equal(routeMessage(msg({ authorId: BOT_ID, guildId: "900", threadParentId: "c1" }), BOT, GUILDS), null);
  assert.equal(routeMessage(msg({ authorId: BOT_ID }), BOT, GUILDS), null);
});

test("another bot routes like any author, so a mention from it can open a turn", () => {
  const other = { authorIsBot: true, authorId: "555" };
  assert.deepEqual(
    routeMessage(msg({ ...other, guildId: "900", content: "<@999> sync", mentionedUserIds: [BOT_ID] }), BOT, GUILDS),
    { target: "new-thread", text: "@qm sync", title: "sync" },
  );
  assert.equal(routeMessage(msg({ ...other, guildId: "900", content: "status" }), BOT, GUILDS), null);
});

test("a message that is only the bot mention still routes", () => {
  assert.deepEqual(routeMessage(msg({ guildId: "900", content: "<@999>", mentionedUserIds: [BOT_ID] }), BOT, GUILDS), {
    target: "new-thread",
    text: "@qm",
    title: "",
  });
});

test("guild threads are channel conversations carrying their audience", () => {
  const audience = [{ externalId: "discord:111" }];
  const target = { kind: "thread" as const, threadId: "t1", scopeChannelId: "c1", channelName: "eng" };
  assert.deepEqual(conversationFor(target, audience), {
    kind: "channel",
    threadRef: "discord:th:t1",
    channelRef: "c1",
    channelName: "eng",
    audience,
  });
  assert.equal(deliveryTargetFor(target), "t1");
  assert.deepEqual(conversationFor({ kind: "dm", channelId: "d1" }), {
    kind: "dm",
    threadRef: "discord:dm:d1",
    channelRef: "d1",
  });
});

test("thread names are the first line capped at 100 chars", () => {
  assert.equal(threadName("a".repeat(150)).length, 100);
  assert.equal(threadName("first\nsecond"), "first");
  assert.equal(threadName("   "), "QM");
});
