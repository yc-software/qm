import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGuildTurnContext } from "../src/discord/conversation-context.ts";
import type { HistoryMessage } from "../src/discord/context.ts";
import type { ActorAssertion } from "../src/types.ts";

const BOT = "900000000000000001";

function member(userId: string, displayName: string): ActorAssertion {
  return { externalId: `discord:${userId}`, displayName, isExternalGuest: false };
}

async function build(audience: ActorAssertion[]) {
  const counts: number[] = [];
  const history: HistoryMessage[] = [];
  const ctx = await buildGuildTurnContext(
    {
      reader: {
        recent: async (_channel, opts) => {
          counts.push(opts.count);
          return history;
        },
        thread: async () => ({ ownerId: null, starter: null }),
      },
      botUserId: BOT,
      botName: "qm",
    },
    { triggerId: "1", historyChannelId: "c1", threadId: null, audience },
  );
  return { ctx, counts };
}

test("history is fetched as one small window, not the full Discord page", async () => {
  const { counts } = await build([member("111111111111111111", "Zed")]);
  assert.equal(counts.length, 1);
  assert.ok(counts[0]! < 40, `fetched ${counts[0]}`);
});
