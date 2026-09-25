import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache, createPostgresSurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createMirror, slackMessageToIngestEvent } from "../src/slack/mirror.ts";
import { toEvent } from "../src/api/routes/surface-cache.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { buildContextWindow } from "../src/slack/conversation.ts";
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

test("event mirroring preserves mention IDs for current-context rendering", async () => {
  const cache = createMemorySurfaceCache();
  const core = {
    ingestSurfaceEvents: async (events) => {
      await cache.ingest(events);
    },
    readSurfaceMessages: cache.readMessages,
  } as SlackCoreClient;
  const mentionDirectory = {
    classifyUserCached: async () => ({ actor: { displayName: "Old name" } }),
  } as unknown as Directory;
  const mirror = createMirror({
    core,
    ids,
    directory: mentionDirectory,
    externalParticipantsEnabled: async () => true,
  });
  const raw = {
    channel: "C",
    channel_type: "channel" as const,
    ts: "1000",
    text: "Hi <@U1> and <@U2> &amp; welcome",
    user: "U1",
  };
  await mirror.mirrorMessageEvent(raw, {});
  const stored = (await cache.readMessages("C"))[0]!;
  assert.equal(stored.text, "Hi <@U1> and <@U2> & welcome");
  assert.deepEqual(stored.mentions, { U1: "Old name", U2: "Old name" });
  const shaped = [];
  for (const source of ["live", "mirror"] as const) {
    const readHistory = createSlackHistoryReader({ core, ids, source });
    const serializer = createConversationSerializer({
      ids,
      directory: mentionDirectory,
      externalParticipantsEnabled: async () => true,
      readHistory,
    });
    const page = await readHistory({ conversations: { history: async () => ({ messages: [raw] }) } }, "C");
    shaped.push(await serializer.shapeRecentMessages({}, page.raw, "", new Map([["U1", "New name"]])));
  }
  assert.deepEqual(shaped[1], shaped[0]);
  assert.equal(shaped[1]![0]!.text, "Hi <@U1> and <@U2> & welcome");
  assert.equal(shaped[1]![0]!.name, "New name");
  const context = buildContextWindow(shaped[1]!, { count: 20, nameById: new Map([["U1", "New name"]]) });
  assert.equal(context.messages[0]!.text, "Hi @New name and <@U2> & welcome");
});

for (const postgres of [false, true]) {
  test(
    `bot and attachment presentation metadata roundtrip (${postgres ? "postgres" : "memory"})`,
    {
      skip: postgres && !process.env.DATABASE_URL,
    },
    async () => {
      const cache = postgres ? createPostgresSurfaceCache(process.env.DATABASE_URL!) : createMemorySurfaceCache();
      const container = `presentation-${Date.now()}-${postgres}`;
      const raw = {
        channel: container,
        ts: "1000",
        bot_id: "BOTHER",
        text: "Report",
        files: [{ id: "FLARGE", title: "Large report", size: 1_000_000_001, mimetype: "application/pdf" }],
      };
      const event = toEvent(slackMessageToIngestEvent(raw, ids))!;
      try {
        await cache.ingest([event]);
        await cache.ingest([{ container, ts: "1000", text: "Report", editedAt: 20 }]);
        await cache.ingest([
          {
            container,
            ts: "1000",
            text: "stale",
            editedAt: 10,
            botId: "BWRONG",
            files: [{ fileId: "FWRONG" }],
            handled: true,
          },
        ]);
        const stored = (await cache.readMessages(container))[0]!;
        assert.equal(stored.botId, "BOTHER");
        assert.equal(stored.files![0]!.title, "Large report");
        assert.equal(stored.files![0]!.size, 1_000_000_001);
        const core = { readSurfaceMessages: cache.readMessages } as SlackCoreClient;
        const client = {
          conversations: { replies: async () => ({ messages: [raw] }) },
          bots: {
            info: async ({ bot }: { bot: string }) => {
              assert.equal(bot, "BOTHER");
              return { bot: { name: "Report bot" } };
            },
          },
        };
        const views = [];
        for (const source of ["live", "mirror"] as const) {
          const serializer = createConversationSerializer({
            ids,
            directory,
            externalParticipantsEnabled: async () => true,
            readHistory: createSlackHistoryReader({ core, ids, source }),
          });
          const result = await serializer.serializeSlackConversation(
            client,
            {
              kind: "channel",
              channel: container,
              threadTs: "1000",
              ts: "1001",
              rawText: "question",
              userId: "U1",
              files: [],
            },
            { audience: [] },
          );
          views.push(result.view);
          const current = await serializer.serializeSlackConversation(
            client,
            {
              kind: "channel",
              channel: container,
              threadTs: "1000",
              ts: "1001",
              rawText: "question",
              userId: "U1",
              files: raw.files,
            },
            { audience: [] },
          );
          assert.deepEqual(current.view.omittedFiles, [{ name: "Large report", reason: "too-big" }]);
        }
        assert.deepEqual(views[1]!.messages, views[0]!.messages);
        assert.equal(views[1]!.messages[0]!.authorId, "BOTHER");
        assert.equal(views[1]!.messages[0]!.name, "Report bot");
        assert.deepEqual(views[1]!.files, views[0]!.files);
        assert.deepEqual(views[1]!.messages[0]!.files, ["Large report"]);
        assert.deepEqual(views[1]!.files, []);
        assert.deepEqual(views[1]!.omittedFiles, []);
        await cache.ingest([{ container, ts: "1000", deleted: true }]);
        await cache.ingest([{ ...event, botId: "BWRONG", editedAt: 30 }]);
        assert.equal((await cache.readMessages(container, { includeDeleted: true }))[0]!.botId, "BOTHER");
      } finally {
        await cache.close();
      }
    },
  );
}

test("HTTP ingestion rejects invalid file sizes", () => {
  for (const size of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, "10"]) {
    assert.equal(toEvent({ container: "C", ts: "1", files: [{ fileId: "F", size }] })!.files![0]!.size, undefined);
  }
  assert.equal(toEvent({ container: "C", ts: "1", files: [{ fileId: "F", size: 0 }] })!.files![0]!.size, 0);
});
