import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldMirror, toIngestEvent } from "../src/discord/mirror.ts";
import type { DiscordInbound } from "../src/discord/events.ts";

const base: DiscordInbound = {
  id: "1300000000000000001",
  channelId: "t1",
  guildId: "900",
  threadParentId: "c1",
  channelName: "eng",
  authorId: "111",
  authorName: "Ana",
  authorIsBot: false,
  content: "hi <@999>",
  mentionedUserIds: ["999"],
  attachments: [],
};

test("guild messages become ingest events keyed by thread and snowflake", () => {
  assert.deepEqual(toIngestEvent(base, "999", { handled: true, createdAt: 5 }), {
    container: "t1",
    ts: "1300000000000000001",
    authorId: "discord:111",
    authorName: "Ana",
    text: "hi <@999>",
    mentionsSelf: true,
    self: false,
    bot: false,
    handled: true,
    createdAt: 5,
    kind: "channel",
    containerName: "eng",
  });
});

test("only mentions, own posts and staked threads are mirrored; DMs never", () => {
  assert.equal(shouldMirror(base, "999", false), true);
  assert.equal(shouldMirror({ ...base, mentionedUserIds: [] }, "999", false), false);
  assert.equal(shouldMirror({ ...base, mentionedUserIds: [] }, "999", true), true);
  assert.equal(shouldMirror({ ...base, mentionedUserIds: [], authorId: "999" }, "999", false), true);
  assert.equal(shouldMirror({ ...base, guildId: null }, "999", true), false);
});
