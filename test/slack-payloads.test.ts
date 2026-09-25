import { test } from "node:test";
import assert from "node:assert/strict";
import bolt from "@slack/bolt";
import {
  channelShareTs,
  parseBlockAction,
  parseChannelPage,
  parseEventId,
  parseInteractionBody,
  parseLifecycleEvent,
  parseLogLevel,
  parseMessageEvent,
  parseMessageList,
  parseReactionEvent,
  parseUploadedFileIds,
  slackErrorCode,
} from "../src/slack/payloads.ts";
import { APPROVAL_ACTION_IDS } from "../src/slack/approval-cards.ts";

test("parseEventId pulls event_id and tolerates junk", () => {
  assert.equal(parseEventId({ event_id: "Ev123", type: "event_callback" }), "Ev123");
  assert.equal(parseEventId({}), undefined);
  assert.equal(parseEventId(undefined), undefined);
  assert.equal(parseEventId({ event_id: 42 }), undefined);
});

test("parseMessageEvent shapes a plain channel message", () => {
  const m = parseMessageEvent({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "hello <@BOT>",
    ts: "1723.0001",
    thread_ts: "1723.0000",
    client_msg_id: "cm-1",
    files: [{ id: "F1", name: "a.txt" }],
  });
  assert.equal(m.channel, "C1");
  assert.equal(m.channel_type, "channel");
  assert.equal(m.user, "U1");
  assert.equal(m.text, "hello <@BOT>");
  assert.equal(m.ts, "1723.0001");
  assert.equal(m.thread_ts, "1723.0000");
  assert.equal(m.client_msg_id, "cm-1");
  assert.deepEqual(m.files, [{ id: "F1", name: "a.txt" }]);
  assert.equal(m.message, undefined);
});

test("parseMessageEvent defaults channel/ts to empty strings and files to []", () => {
  const m = parseMessageEvent({ type: "message" });
  assert.equal(m.channel, "");
  assert.equal(m.ts, "");
  assert.deepEqual(m.files, []);
  assert.equal(m.user, undefined);
  assert.equal(m.bot_profile, undefined);
});

test("parseMessageEvent keeps unrecognized raw fields riding along", () => {
  const m = parseMessageEvent({
    channel: "C1",
    ts: "1.2",
    attachments: [{ text: "from a legacy attachment" }],
    edited: { ts: "1.3" },
  });
  const carried = new Map(Object.entries(m));
  assert.deepEqual(carried.get("attachments"), [{ text: "from a legacy attachment" }]);
  assert.deepEqual(carried.get("edited"), { ts: "1.3" });
});

test("parseMessageEvent String-coerces the ts-family fields like the old call sites did", () => {
  const m = parseMessageEvent({
    channel: 5,
    ts: 1723.0001,
    thread_ts: 1723,
    deleted_ts: 1724,
    subtype: "message_deleted",
  });
  assert.equal(m.channel, "5");
  assert.equal(m.ts, "1723.0001");
  assert.equal(m.thread_ts, "1723");
  assert.equal(m.deleted_ts, "1724");
});

test("parseMessageEvent keeps the nested message of a message_changed event", () => {
  const m = parseMessageEvent({
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "1723.0002",
    message: {
      user: "U1",
      text: "edited",
      ts: "1723.0001",
      thread_ts: "1723.0000",
      bot_profile: { name: "deploybot" },
    },
  });
  assert.equal(m.subtype, "message_changed");
  assert.equal(m.message?.text, "edited");
  assert.equal(m.message?.ts, "1723.0001");
  assert.equal(m.message?.thread_ts, "1723.0000");
  assert.equal(m.message?.bot_profile?.name, "deploybot");
});

test("parseMessageEvent keeps bot_profile presence even without a name", () => {
  const m = parseMessageEvent({ channel: "C1", ts: "1.2", bot_id: "B9", bot_profile: {} });
  assert.ok(m.bot_profile);
  assert.equal(m.bot_profile?.name, undefined);
});

test("parseMessageEvent shapes message_deleted with previous_message", () => {
  const m = parseMessageEvent({
    subtype: "message_deleted",
    channel: "C1",
    channel_type: "im",
    deleted_ts: "1723.0001",
    ts: "1723.0009",
    previous_message: { user: "UBOT", bot_id: "B1", thread_ts: "1700.0001" },
  });
  assert.equal(m.deleted_ts, "1723.0001");
  assert.deepEqual(m.previous_message, { user: "UBOT", bot_id: "B1", thread_ts: "1700.0001" });
});

test("parseMessageEvent drops a malformed non-array files value", () => {
  const m = parseMessageEvent({ channel: "C1", ts: "1.2", files: { sneaky: true } });
  assert.deepEqual(m.files, []);
});

test("parseReactionEvent shapes a reaction_added payload", () => {
  const e = parseReactionEvent({
    user: "U1",
    reaction: "eyes",
    item_user: "UBOT",
    item: { type: "message", channel: "C1", ts: "1723.0001" },
    event_ts: "1723.0002",
  });
  assert.deepEqual(e, {
    user: "U1",
    reaction: "eyes",
    item_user: "UBOT",
    item: { type: "message", channel: "C1", ts: "1723.0001" },
    event_ts: "1723.0002",
  });
  assert.deepEqual(parseReactionEvent({}).item, undefined);
});

test("parseLifecycleEvent reads channel as a string or an object id", () => {
  assert.deepEqual(parseLifecycleEvent({ user: "U1", channel: "C1", event_ts: "9.9" }), {
    user: "U1",
    channel: "C1",
    eventTs: "9.9",
  });
  assert.equal(parseLifecycleEvent({ channel: { id: "C2", name: "eng" } }).channel, "C2");
  assert.equal(parseLifecycleEvent({}).channel, undefined);
});

test("parseInteractionBody extracts the clicker, channel, and card message", () => {
  const click = parseInteractionBody({
    type: "block_actions",
    user: { id: "U1", username: "josh" },
    channel: { id: "C1", name: "eng" },
    message: { ts: "1723.0002", thread_ts: "1723.0001", text: "card" },
  });
  assert.deepEqual(click, {
    clickerId: "U1",
    channel: "C1",
    messageTs: "1723.0002",
    messageThreadTs: "1723.0001",
  });
});

test("parseInteractionBody falls back like the old inline extraction", () => {
  const click = parseInteractionBody({ type: "block_actions" });
  assert.equal(click.clickerId, "");
  assert.equal(click.channel, undefined);
  assert.equal(click.messageTs, undefined);
  assert.equal(click.messageThreadTs, undefined);
  assert.equal(parseInteractionBody(undefined).clickerId, "");
});

test("parseBlockAction admits only known action ids and stringifies value", () => {
  assert.deepEqual(parseBlockAction({ action_id: "hilo_deny", value: "req-1" }, APPROVAL_ACTION_IDS), {
    actionId: "hilo_deny",
    value: "req-1",
  });
  assert.equal(parseBlockAction({ action_id: "hilo_bogus", value: "req-1" }, APPROVAL_ACTION_IDS), undefined);
  assert.deepEqual(parseBlockAction({ action_id: "hilo_deny" }, APPROVAL_ACTION_IDS), {
    actionId: "hilo_deny",
    value: "",
  });
  assert.equal(parseBlockAction(undefined, APPROVAL_ACTION_IDS), undefined);
});

test("parseMessageList reads messages and has_more, tolerating junk", () => {
  const { messages, hasMore } = parseMessageList({
    ok: true,
    messages: [{ ts: "1.1", user: "U1", text: "hi" }],
    has_more: true,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.ts, "1.1");
  assert.equal(hasMore, true);
  assert.deepEqual(parseMessageList({ ok: true }), { messages: [], hasMore: false });
  assert.deepEqual(parseMessageList(undefined), { messages: [], hasMore: false });
});

test("parseUploadedFileIds reads every file from each uploadV2 response shape", () => {
  assert.deepEqual(parseUploadedFileIds({ files: [{ files: [{ id: "F1" }, { id: "F2" }] }] }), ["F1", "F2"]);
  assert.deepEqual(parseUploadedFileIds({ files: [{ id: "F2" }, { id: "F3" }] }), ["F2", "F3"]);
  assert.deepEqual(parseUploadedFileIds({ file: { id: "F3" } }), ["F3"]);
  assert.deepEqual(parseUploadedFileIds({ files: { "0": { id: "F4" } } }), ["F4"]);
  assert.deepEqual(parseUploadedFileIds({ files: [{ files: [{}] }] }), []);
  assert.deepEqual(parseUploadedFileIds({}), []);
  assert.deepEqual(parseUploadedFileIds(undefined), []);
});

test("channelShareTs merges public and private shares for the channel", () => {
  const res = {
    ok: true,
    file: {
      shares: {
        public: { C1: [{ ts: "1.1" }], C2: [{ ts: "2.2" }] },
        private: { C3: [{ ts: "3.3" }] },
      },
    },
  };
  assert.equal(channelShareTs(res, "C1"), "1.1");
  assert.equal(channelShareTs(res, "C3"), "3.3");
  assert.equal(channelShareTs(res, "C9"), undefined);
  assert.equal(channelShareTs({}, "C1"), undefined);
  assert.equal(channelShareTs({ file: { shares: { public: { C1: [{}] } } } }, "C1"), undefined);
});

test("channelShareTs throws loudly on a malformed shares entry", () => {
  assert.throws(() => channelShareTs({ file: { shares: { public: { C1: { not: "a list" } } } } }, "C1"), TypeError);
});

test("parseChannelPage reads conversations.list pages", () => {
  assert.deepEqual(parseChannelPage({ channels: [{ id: "C1", is_member: true }] }), [{ id: "C1", is_member: true }]);
  assert.deepEqual(parseChannelPage({}), []);
});

test("slackErrorCode reads the Slack API error code off a thrown error", () => {
  assert.equal(slackErrorCode({ data: { error: "not_in_channel" } }), "not_in_channel");
  assert.equal(slackErrorCode(new Error("boom")), undefined);
  assert.equal(slackErrorCode(undefined), undefined);
});

test("parseLogLevel admits bolt levels and defaults everything else to info", () => {
  assert.equal(parseLogLevel("debug"), bolt.LogLevel.DEBUG);
  assert.equal(parseLogLevel("error"), bolt.LogLevel.ERROR);
  assert.equal(parseLogLevel("verbose"), bolt.LogLevel.INFO);
  assert.equal(parseLogLevel(undefined), bolt.LogLevel.INFO);
});

test("parseMessageEvent keeps previous_message.text so unchanged edits can be told from real ones", () => {
  const m = parseMessageEvent({
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "1723.0009",
    message: { user: "U1", text: "same text", ts: "1723.0001" },
    previous_message: { user: "U1", text: "same text" },
  });
  assert.equal(m.previous_message?.text, "same text");
  assert.equal(m.message?.text, "same text");
});
