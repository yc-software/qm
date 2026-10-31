import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscordReactions, emojiDisplayName, reactionTallies } from "../src/discord/reactions.ts";

const T = { channelId: "c1", messageId: "m1" };
const sender = (sent: string[], failOn?: string) => ({
  react: async (_c: string, _m: string, e: string) => {
    if (e === failOn) throw new Error("nope");
    sent.push(e);
  },
});

test("applyDiscordReactions dedupes, resolves names and caps at five", async () => {
  const sent: string[] = [];
  const names = ["tada", "tada", "eyes", "rocket", "fire", "heart", "100", "star"];
  const out = await applyDiscordReactions(sender(sent), T, names);
  assert.deepEqual(sent, ["🎉", "👀", "🚀", "🔥", "❤️"]);
  assert.deepEqual(out.added, ["tada", "eyes", "rocket", "fire", "heart"]);
  assert.deepEqual(out.failed, []);
});

test("applyDiscordReactions reports unresolved names and send failures", async () => {
  const sent: string[] = [];
  const out = await applyDiscordReactions(sender(sent, "🎉"), T, ["no_such_emoji_zz", "tada", "eyes"]);
  assert.deepEqual(sent, ["👀"]);
  assert.deepEqual(out.added, ["eyes"]);
  assert.deepEqual(out.failed.sort(), ["no_such_emoji_zz", "tada"]);
});

test("reactionTallies names unicode and custom emoji and drops empty counts", () => {
  const rows = [
    { emoji: { name: "👍", id: null }, count: 2 },
    { emoji: { name: "party", id: "5" }, count: 1 },
    { emoji: { name: "spin", id: "6", animated: true }, count: 3 },
    { emoji: { name: "🎉", id: null }, count: 0 },
  ];
  const out = reactionTallies(rows as never);
  assert.deepEqual(
    out.map((t) => [t.name, t.count]),
    [
      ["+1", 2],
      ["<:party:5>", 1],
      ["<a:spin:6>", 3],
    ],
  );
  assert.equal(emojiDisplayName({ name: "party", id: "5" } as never), "<:party:5>");
});
