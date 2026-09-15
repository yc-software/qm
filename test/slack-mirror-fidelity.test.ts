import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache, createPostgresSurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { slackMessageToIngestEvent } from "../src/slack/mirror.ts";
import { toEvent } from "../src/api/routes/surface-cache.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;
const directory = {
  classifyUserCached: async (_client: unknown, user: string) => ({ actor: { displayName: user } }),
} as unknown as Directory;

for (const postgres of [false, true]) {
  test(
    `subtype roundtrip and stale/partial/deleted protection (${postgres ? "postgres" : "memory"})`,
    {
      skip: postgres && !process.env.DATABASE_URL,
    },
    async () => {
      const cache = postgres ? createPostgresSurfaceCache(process.env.DATABASE_URL!) : createMemorySurfaceCache();
      const container = `fidelity-${Date.now()}-${postgres}`;
      const read = async () => (await cache.readMessages(container, { at: "1", includeDeleted: true }))[0]!;
      try {
        await cache.ingest([{ container, ts: "1", text: "legacy" }]);
        assert.equal((await read()).subtype, undefined);
        await cache.ingest([{ container, ts: "1", text: "joined", subtype: "channel_join", editedAt: 10 }]);
        await cache.ingest([{ container, ts: "1", text: "partial", editedAt: 20 }]);
        assert.equal((await read()).subtype, "channel_join");
        await cache.ingest([{ container, ts: "1", text: "stale", subtype: "", editedAt: 10, handled: true }]);
        assert.equal((await read()).subtype, "channel_join");
        await cache.ingest([{ container, ts: "1", text: "ordinary", subtype: "", editedAt: 30 }]);
        assert.equal((await read()).subtype, "");
        await cache.ingest([{ container, ts: "1", deleted: true, subtype: "tombstone" }]);
        await cache.ingest([{ container, ts: "1", text: "resurrection", subtype: "bot_message", editedAt: 40 }]);
        assert.equal((await read()).subtype, "");
        assert.equal((await read()).deleted, true);
      } finally {
        await cache.close();
      }
    },
  );
}

test("canonical snapshots cross the HTTP mapper with explicit empty files, roots and bot identity", () => {
  const event = toEvent(
    slackMessageToIngestEvent(
      { channel: "C", ts: "1", bot_id: "BBOT", bot_profile: { name: "QM" }, text: "A &amp; B" },
      ids,
    ),
  )!;
  assert.equal(event.text, "A & B");
  assert.equal(event.sub, null);
  assert.equal(event.subtype, "");
  assert.equal(event.broadcast, false);
  assert.equal(event.authorName, "QM");
  assert.equal(event.bot, true);
  assert.equal(event.self, true);
  assert.deepEqual(event.files, []);
  const partial = slackMessageToIngestEvent({ channel: "C", ts: "1", text: "edit" }, ids, {
    partial: true,
    editedAt: 20,
  });
  assert.equal(partial.subtype, undefined);
  assert.equal(partial.broadcast, undefined);
  assert.equal(partial.sub, undefined);
});

test("mirror and live render the same allowed message subtypes", async () => {
  const raw = [
    undefined,
    "file_share",
    "bot_message",
    "thread_broadcast",
    "channel_join",
    "channel_topic",
    "tombstone",
  ].map((subtype, i) => ({ ts: `1000.00000${i}`, text: `body-${i}`, user: "U1", subtype }));
  const cache = createMemorySurfaceCache();
  await cache.ingest(raw.map((m) => toEvent(slackMessageToIngestEvent({ ...m, channel: "C" }, ids))!));
  const core = { readSurfaceMessages: cache.readMessages } as SlackCoreClient;
  const client = { conversations: { history: async () => ({ messages: raw.slice().reverse(), has_more: false }) } };
  const views = [];
  for (const source of ["live", "mirror"] as const) {
    const serializer = createConversationSerializer({
      ids,
      directory,
      externalParticipantsEnabled: async () => false,
      readHistory: createSlackHistoryReader({ core, ids, source }),
    });
    const result = await serializer.serializeSlackConversation(
      client,
      { kind: "channel", channel: "C", ts: "1000.000009", rawText: "trigger", userId: "U1", files: [] },
      { audience: [] },
    );
    views.push(result.view.messages);
  }
  assert.deepEqual(views[1], views[0]);
  assert.equal(views[0]!.filter((m) => m.text.startsWith("body-")).length, 4);
});

test("fallback prefers fresh live duplicates and replaces removed files", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C", ts: "2", sub: "1", text: "stale", files: [{ fileId: "FOLD" }] }]);
  const core = {
    readSurfaceMessages: cache.readMessages,
    rememberSurfaceHistory: async (events) => {
      await cache.ingest(events.map((e) => toEvent(e)!));
    },
  } as SlackCoreClient;
  const read = createSlackHistoryReader({ core, ids, source: "mirror" });
  const page = await read(
    {
      conversations: {
        replies: async () => ({
          messages: [
            { ts: "1", text: "parent" },
            { ts: "2", thread_ts: "1", text: "fresh", edited: { ts: "3" }, bot_profile: { name: "Author" } },
          ],
        }),
      },
    },
    "C",
    "1",
  );
  assert.equal(page.raw.find((m) => m.ts === "2")?.text, "fresh");
  const stored = (await cache.readMessages("C", { at: "2" }))[0]!;
  assert.equal(stored.authorName, "Author");
  assert.equal(stored.bot, true);
  assert.equal(stored.files?.length ?? 0, 0);
});

test("live and shadow do not repair their own comparison source", async () => {
  for (const source of ["live", "shadow"] as const) {
    let writes = 0;
    const read = createSlackHistoryReader({
      ids,
      source,
      core: {
        readSurfaceMessages: async () => [],
        rememberSurfaceHistory: async () => {
          writes++;
        },
      } as unknown as SlackCoreClient,
    });
    await read({ conversations: { history: async () => ({ messages: [{ ts: "1", text: "live" }] }) } }, "C");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 0);
  }
});
