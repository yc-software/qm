import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import { renderConversationView } from "../src/slack/conversation.ts";
import { overheardItem, selectOverheardToImport } from "../src/agent/replay.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";
import type { SlackHistoryMessage } from "../src/slack/payloads.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT", botHandle: "qm" } as BotIdentity;
const actors: Record<string, { externalId: string; displayName: string; isBot?: true }> = {
  UALICE: { externalId: "alice@example.com", displayName: "Alice" },
  UGH: { externalId: "UGH", displayName: "github", isBot: true },
};
const crowd = Array.from({ length: 12 }, (_, i) => i);
for (const i of crowd) {
  actors[`UA${i}`] = { externalId: `a${i}@example.com`, displayName: `Author ${i}` };
  actors[`UM${i}`] = { externalId: `m${i}@example.com`, displayName: `Mentioned ${i}` };
}
const directory = {
  classifyUserCached: async (_client: unknown, id: string) => ({ actor: actors[id], ok: true }),
} as unknown as Directory;

async function copiedIn(raw: SlackHistoryMessage[], threadTs: string, ts: string) {
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => true,
    readHistory: async () => ({ raw, hasMore: false }),
  });
  const { view } = await serializer.serializeSlackConversation(
    {},
    { kind: "channel", channel: "C1", threadTs, ts, files: [] },
    { audience: [] },
  );
  return selectOverheardToImport(renderConversationView(view).overheard, new Set()).map(overheardItem);
}

test("Slack messages copied into a session keep the person who wrote them, even when sent through an app", async () => {
  const assistantApp = { name: "Assistant" };
  const raw: SlackHistoryMessage[] = [
    { ts: "1.0", user: "UALICE", text: "<@UBOT> why didn't you respond here" },
    { ts: "2.0", user: "UBOT", bot_id: "BBOT", bot_profile: assistantApp, text: "On it." },
    { ts: "3.0", user: "UALICE", bot_id: "BAPP", bot_profile: assistantApp, text: "sent from the web" },
    { ts: "4.0", user: "UGH", bot_id: "BGH", bot_profile: { name: "GitHub" }, text: "PR merged" },
    { ts: "9.0", user: "UALICE", text: "<@UBOT> look me up" },
  ];
  const items = await copiedIn(raw, "1.0", "9.0");
  assert.deepEqual(
    items.map((item) => [item.text, item.body?.name, item.body?.speakerId, item.body?.sourceRole]),
    [
      ["@qm why didn't you respond here", "Alice", "alice@example.com", undefined],
      ["On it.", undefined, undefined, "agent"],
      ["sent from the web", "Alice", "alice@example.com", undefined],
      ["PR merged", "GitHub", undefined, undefined],
    ],
  );
});

test("a busy thread resolves every author and mentioned person, not only the first ten", async () => {
  const raw: SlackHistoryMessage[] = crowd.map((i) => ({ ts: `${i + 10}.0`, user: `UA${i}`, text: `<@UM${i}> hello` }));
  raw.push({ ts: "99.0", user: "UALICE", text: "<@UBOT> summarize" });
  assert.deepEqual(
    (await copiedIn(raw, "10.0", "99.0")).map((item) => [item.text, item.body?.name, item.body?.speakerId]),
    crowd.map((i) => [`@Mentioned ${i} hello`, `Author ${i}`, `a${i}@example.com`]),
  );
});
