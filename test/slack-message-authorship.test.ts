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
const directory = {
  classifyUserCached: async (_client: unknown, id: string) => ({ actor: actors[id], ok: true }),
} as unknown as Directory;

test("Slack messages copied into a session keep the person who wrote them, even when sent through an app", async () => {
  const assistantApp = { name: "Assistant" };
  const raw: SlackHistoryMessage[] = [
    { ts: "1.0", user: "UALICE", text: "<@UBOT> why didn't you respond here" },
    { ts: "2.0", user: "UBOT", bot_id: "BBOT", bot_profile: assistantApp, text: "On it." },
    { ts: "3.0", user: "UALICE", bot_id: "BAPP", bot_profile: assistantApp, text: "sent from the web" },
    { ts: "4.0", user: "UGH", bot_id: "BGH", bot_profile: { name: "GitHub" }, text: "PR merged" },
    { ts: "9.0", user: "UALICE", text: "<@UBOT> look me up" },
  ];
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => true,
    readHistory: async () => ({ raw, hasMore: false }),
  });
  const { view } = await serializer.serializeSlackConversation(
    {},
    { kind: "channel", channel: "C1", threadTs: "1.0", ts: "9.0", files: [] },
    { audience: [] },
  );
  const items = selectOverheardToImport(renderConversationView(view).overheard, new Set()).map(overheardItem);
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
