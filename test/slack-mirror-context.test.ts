import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import { renderConversationView } from "../src/slack/conversation.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;
const directory = {
  classifyUserCached: async (id: unknown, user: string) => ({ actor: { displayName: user } }),
} as unknown as Directory;

function fixture() {
  const cache = createMemorySurfaceCache();
  const core = {
    readSurfaceMessages: cache.readMessages,
    rememberSurfaceHistory: async (events) => {
      await cache.ingest(events);
    },
  } as SlackCoreClient;
  const readHistory = createSlackHistoryReader({
    core,
    ids,
    source: "mirror",
    managed: true,
    setupUrl: "https://qm.test/admin/?setup=slack",
  });
  const client = {
    conversations: {
      history: async () => {
        throw new Error("unexpected history read");
      },
      replies: async () => {
        throw new Error("unexpected replies read");
      },
    },
  };
  return { cache, core, readHistory, client };
}

test("warm thread context follows reordered edits and deletes with no history requests", async () => {
  const { cache, readHistory, client } = fixture();
  await cache.ingest([
    { container: "C1", ts: "2.000000", sub: "1.000000", text: "reply", authorId: "U2" },
    { container: "C1", ts: "1.000000", text: "parent", authorId: "U1" },
    { container: "OTHER", ts: "3.000000", text: "secret" },
  ]);
  await cache.ingest([{ container: "C1", ts: "2.000000", text: "edited", editedAt: 10 }]);
  await cache.ingest([{ container: "C1", ts: "2.000000", text: "stale", handled: true }]);
  const first = await readHistory(client, "C1", "1.000000");
  assert.deepEqual(first.raw.map((m) => m.text).sort(), ["edited", "parent"]);
  assert.match(first.note!, /not a complete/);
  await cache.ingest([{ container: "C1", ts: "2.000000", deleted: true }]);
  assert.deepEqual(
    (await readHistory(client, "C1", "1.000000")).raw.map((m) => m.text),
    ["parent"],
  );
});

test("automatic context renders overheard messages and preserves literal entities and files", async () => {
  const { cache, readHistory, client } = fixture();
  await cache.ingest([
    {
      container: "C1",
      ts: "1000.000001",
      text: "literal &lt;",
      authorId: "U1",
      files: [{ fileId: "F1", name: "notes.txt" }],
    },
    { container: "C1", ts: "1000.000002", text: "answer", self: true },
  ]);
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => false,
    readHistory,
  });
  const result = await serializer.serializeSlackConversation(
    client,
    { kind: "channel", channel: "C1", ts: "1000.000003", rawText: "trigger", userId: "U1", files: [] },
    { audience: [] },
  );
  assert.equal(result.view.messages.find((m) => m.ts === "1000.000001")?.text, "literal &lt;");
  assert.deepEqual(result.view.messages.find((m) => m.ts === "1000.000001")?.files, ["notes.txt"]);
  const rendered = renderConversationView(result.view);
  assert.ok(rendered.overheard.some((m) => m.text.includes("literal &lt;")));
  assert.match(rendered.header, /stored Slack events/);
});

test("missing parent falls back once then the returned parent is stored for later turns", async () => {
  const { cache, readHistory, client } = fixture();
  await cache.ingest([{ container: "C1", ts: "2.000000", sub: "1.000000", text: "reply" }]);
  let reads = 0;
  client.conversations.replies = async () => {
    reads++;
    return { messages: [{ ts: "1.000000", text: "parent" }], has_more: true } as never;
  };
  assert.match((await readHistory(client, "C1", "1.000000")).note!, /truncated/);
  await readHistory(client, "C1", "1.000000");
  assert.equal(reads, 1);
});

test("partial mirror retains Slack throttling guidance", async () => {
  const { cache, readHistory, client } = fixture();
  await cache.ingest([{ container: "C1", ts: "2.000000", sub: "1.000000", text: "reply" }]);
  client.conversations.replies = async () => {
    throw { code: "slack_webapi_rate_limited_error", retryAfter: 60 };
  };
  const result = await readHistory(client, "C1", "1.000000");
  assert.equal(result.raw.length, 1);
  assert.match(result.note!, /60/);
  assert.match(result.note!, /https:\/\/qm.test\/admin/);
});

test("external audience is rejected before reading mirror or Slack", async () => {
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => false,
    readHistory: async () => {
      throw new Error("unauthorized read");
    },
  });
  const result = await serializer.serializeSlackConversation(
    {},
    { kind: "channel", channel: "C1", ts: "1", files: [] },
    { audience: [{ externalId: "U1", isExternalGuest: true }] },
  );
  assert.deepEqual(result.view.messages, []);
});

test("failed reads preserve the triggering event in automatic context", async () => {
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => false,
    readHistory: async () => {
      throw new Error("storage unavailable");
    },
  });
  const result = await serializer.serializeSlackConversation(
    {},
    { kind: "channel", channel: "C1", ts: "1", rawText: "trigger", files: [] },
    { audience: [] },
  );
  assert.equal(result.view.messages[0]?.text, "trigger");
  assert.match(result.view.contextNote!, /could not be read/);
});

test("NUL sanitization retains literal backslash-u text and marks stale messages handled", async () => {
  const { cache } = fixture();
  await cache.ingest([{ container: "C1", ts: "1", text: "a\0b \\u0000", editedAt: 10 }]);
  await cache.ingest([{ container: "C1", ts: "1", text: "old", handled: true }]);
  const [message] = await cache.readMessages("C1");
  assert.equal(message?.text, "ab \\u0000");
  assert.equal(message?.handled, true);
});

test("read_thread, whats_new and mirror search retain coverage notes and container isolation", async () => {
  const { createSurfaceToolDeps } = await import("../src/core/orchestrator/surface-tools.ts");
  const { cache } = fixture();
  await cache.ingest([
    { container: "C1", ts: "1.000000", text: "match here" },
    { container: "SECRET", ts: "2.000000", text: "match secret" },
  ]);
  const tools = createSurfaceToolDeps({
    deps: {
      deliveries: {},
      surfaceCache: cache,
      slackContextSource: "mirror",
      surfaceContext: {
        pull: async () => ({
          messages: [{ ts: "2.000000", threadTs: "1.000000", text: "reply" }],
          note: "partial context",
        }),
      },
    },
    input: { surface: "slack", surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "channel" },
    defaultDestination: { type: "slack", target: "C1:1.000000" },
  } as unknown as import("../src/core/orchestrator/surface-tools.ts").SurfaceToolsContext)!;
  assert.equal((await tools.readThread()).message, "partial context");
  assert.equal((await tools.whatsNew()).message, "partial context");
  const search = await tools.search("match", { source: "mirror" });
  assert.equal(search.source, "cache");
  assert.deepEqual(
    search.hits?.map((m) => m.snippet),
    ["match here"],
  );
});

test("backfilled edit timestamps reject older delayed edit events", async () => {
  const { cache, readHistory, client } = fixture();
  client.conversations.replies = async () =>
    ({ messages: [{ ts: "1.000000", text: "latest edit", edited: { ts: "20.000000" } }] }) as never;
  await readHistory(client, "C1", "1.000000");
  await cache.ingest([{ container: "C1", ts: "1.000000", text: "delayed old edit", editedAt: 10_000 }]);
  const [message] = await cache.readMessages("C1");
  assert.equal(message?.text, "latest edit");
  assert.equal(message?.editedAt, 20_000);
  assert.equal((await readHistory(client, "C1", "1.000000")).raw[0]?.text, "latest edit");
});

test("surface context combines channel coverage and thread rate-limit notes", async () => {
  const { createSurfaceContextFulfiller } = await import("../src/slack/surface-context.ts");
  let outcome: any;
  const fulfiller = createSurfaceContextFulfiller({
    core: {
      fulfillContextRequest: async (_id, result) => {
        outcome = result;
      },
    } as SlackCoreClient,
    directory,
    serializer: {
      shapeRecentMessages: async () => [],
    } as unknown as import("../src/slack/conversation-view.ts").ConversationSerializer,
    botToken: "test",
    clientOptions: {},
    readHistory: async (_client, _channel, thread) => ({
      raw: [],
      hasMore: false,
      note: thread
        ? "Retry in 60 seconds; setup: https://qm.test/admin/?setup=slack"
        : "Stored events may be incomplete.",
    }),
  });
  await fulfiller.fulfillSurfaceContext({}, {
    id: "request",
    query: { conversationTarget: "C1:1.0" },
  } as import("../src/api/slack-core-client.ts").SurfaceContextRequest);
  assert.match(outcome.result.note, /Stored events/);
  assert.match(outcome.result.note, /60 seconds/);
  assert.match(outcome.result.note, /setup=slack/);
});

test("surface context keeps a successful channel page when an empty thread is throttled", async () => {
  const { createSurfaceContextFulfiller } = await import("../src/slack/surface-context.ts");
  let outcome: any;
  const fulfiller = createSurfaceContextFulfiller({
    core: {
      fulfillContextRequest: async (_id, result) => {
        outcome = result;
      },
    } as SlackCoreClient,
    directory,
    serializer: {
      shapeRecentMessages: async (_client: unknown, raw: import("../src/slack/payloads.ts").SlackHistoryMessage[]) =>
        raw.map((m) => ({ ts: m.ts!, text: m.text!, name: "Alice" })),
    } as unknown as import("../src/slack/conversation-view.ts").ConversationSerializer,
    botToken: "test",
    clientOptions: {},
    historyRateLimitOptions: { managed: true, setupUrl: "https://qm.test/admin/?setup=slack" },
    readHistory: async (_client, _channel, thread) => {
      if (thread) throw { code: "slack_webapi_rate_limited_error", retryAfter: 60 };
      return {
        raw: [{ ts: "1.0", text: "stored channel message" }],
        hasMore: false,
        note: "Stored events may be incomplete.",
      };
    },
  });
  await fulfiller.fulfillSurfaceContext({}, {
    id: "request",
    query: { conversationTarget: "C1:2.0" },
  } as import("../src/api/slack-core-client.ts").SurfaceContextRequest);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result.messages[0].text, "stored channel message");
  assert.match(outcome.result.note, /Stored events/);
  assert.match(outcome.result.note, /60/);
  assert.match(outcome.result.note, /setup=slack/);
});

test("deleted messages do not consume context page slots or reappear through fallback", async () => {
  const { cache, readHistory, client } = fixture();
  const ts = (n: number) => String(n).padStart(6, "0");
  await cache.ingest(Array.from({ length: 205 }, (_, i) => ({ container: "C1", ts: ts(i), text: "message" })));
  await cache.ingest([{ container: "C1", ts: ts(204), deleted: true }]);
  const page = await readHistory(client, "C1");
  assert.equal(page.raw.length, 200);
  assert.equal(page.raw[0]?.ts, ts(4));
  assert.equal(page.raw.at(-1)?.ts, ts(203));
  await cache.ingest([{ container: "C2", ts: "2.0", sub: "1.0", deleted: true }]);
  client.conversations.replies = async () =>
    ({
      messages: [
        { ts: "1.0", text: "parent" },
        { ts: "2.0", thread_ts: "1.0", text: "deleted reply" },
      ],
    }) as never;
  assert.deepEqual(
    (await readHistory(client, "C2", "1.0")).raw.map((m) => m.ts),
    ["1.0"],
  );
});

test("shared-app shadow compares equal pages while mirror reads retain stored history", async (t) => {
  const { cache, core, readHistory, client } = fixture();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    ts: `${1000 + i}.000000`,
    text: `message ${i}`,
    user: "U1",
  }));
  await cache.ingest(messages.map((m) => ({ container: "C1", ts: m.ts, text: m.text, authorId: m.user })));
  assert.equal((await readHistory(client, "C1")).raw.length, 30);
  let resolveReport!: (value: any) => void;
  const report = new Promise<any>((resolve) => {
    resolveReport = resolve;
  });
  t.mock.method(console, "info", (value: string) => resolveReport(JSON.parse(value)));
  const shadow = createSlackHistoryReader({ core, ids, source: "shadow", managed: true });
  const liveClient = {
    conversations: {
      history: async () => ({ messages: messages.slice(-15).reverse(), has_more: true }),
    },
  };
  assert.equal((await shadow(liveClient, "C1")).raw.length, 15);
  const comparison = await report;
  assert.equal(comparison.matchingMessages, 15);
  assert.equal(comparison.mirrorMessagesOutsideLiveWindow, 0);
  assert.equal(comparison.mirrorHasMore, true);
});

test("thread history keeps file references and authors but only current files are turn attachments", async () => {
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => false,
    readHistory: async () => ({
      hasMore: false,
      raw: [
        { ts: "1000.000001", user: "U1", text: "Review the notes", files: [{ id: "FOLD", name: "old-notes.txt" }] },
        {
          ts: "1000.000002",
          thread_ts: "1000.000001",
          user: "UBOT",
          bot_id: "BBOT",
          text: "Shall I summarize those notes?",
        },
      ],
    }),
  });
  const { view } = await serializer.serializeSlackConversation(
    {},
    {
      kind: "channel",
      channel: "C1",
      threadTs: "1000.000001",
      ts: "1000.000003",
      rawText: "yes",
      userId: "U2",
      files: [{ id: "FCURRENT", name: "current.txt" }],
    },
    { audience: [] },
  );
  assert.deepEqual(view.files, [{ name: "current.txt" }]);
  const rendered = renderConversationView(view);
  assert.equal(rendered.overheard[0]?.name, "U1");
  assert.deepEqual(rendered.overheard[0]?.files, ["old-notes.txt"]);
  assert.equal(rendered.overheard[1]?.role, "self");
  assert.match(rendered.overheard[1]!.text, /Shall I summarize/);
});

test("automatic context keeps the thread parent and recent exchange but excludes old channel chatter", async () => {
  const raw = [
    { ts: "1.000000", user: "U1", text: "ancient unrelated message" },
    { ts: "100000.000000", user: "U1", text: "thread parent" },
    ...Array.from({ length: 50 }, (_, i) => ({
      ts: `${100001 + i}.000000`,
      user: "U2",
      thread_ts: "100000.000000",
      text: `reply ${i}`,
    })),
  ];
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled: async () => false,
    readHistory: async () => ({ raw, hasMore: false }),
  });
  const { view } = await serializer.serializeSlackConversation(
    {},
    {
      kind: "channel",
      channel: "C1",
      ts: "100060.000000",
      rawText: "go",
      userId: "U1",
      files: [],
    },
    { audience: [] },
  );
  assert.equal(view.messages.length, serializer.recentMessageWindow + 1);
  assert.equal(view.messages[0]?.text, "thread parent");
  assert.equal(view.messages.at(-2)?.text, "reply 49");
  assert.equal(
    view.messages.some((m) => m.text === "ancient unrelated message" || m.text === "reply 0"),
    false,
  );
});
