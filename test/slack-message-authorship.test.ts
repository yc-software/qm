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
    { ts: "2.5", user: "UBOT", bot_id: "BBOT", bot_profile: assistantApp, username: "Ada", text: "Morning." },
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
      ["Morning.", "Ada", undefined, "agent"],
      ["sent from the web", "Alice", "alice@example.com", "bot"],
      ["PR merged", "GitHub", undefined, "bot"],
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

test("a mention in a file's thread carries the thread files QM has not answered yet", async () => {
  const raw: SlackHistoryMessage[] = [
    { ts: "1.0", user: "UA0", text: "funny behavior", files: [{ id: "F1", name: "shot.png" }] },
    { ts: "2.0", user: "UALICE", thread_ts: "1.0", text: "mine", files: [{ id: "F2", name: "mine.png" }] },
    { ts: "3.0", user: "UA1", thread_ts: "1.0", text: "theirs", files: [{ id: "F3", name: "theirs.png" }] },
    { ts: "4.0", user: "UALICE", thread_ts: "1.0", text: "<@UBOT> what does this show?" },
  ];
  const inc = { kind: "channel" as const, channel: "C1", threadTs: "1.0", ts: "4.0", userId: "UALICE", files: [] };
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => true,
    readHistory: async () => ({ raw, hasMore: false }),
  });
  const threadFiles = async () =>
    (await serializer.serializeSlackConversation({}, inc, { audience: [] })).threadFiles?.map((f) => f.id);
  assert.deepEqual(await threadFiles(), ["F1", "F2"]);
  raw.splice(2, 0, { ts: "2.5", user: "UBOT", bot_id: "BBOT", thread_ts: "1.0", text: "Looked at it." });
  assert.equal(await threadFiles(), undefined);
});
