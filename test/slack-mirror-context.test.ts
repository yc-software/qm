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
