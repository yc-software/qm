import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/surfaces/surface-tools.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createChannelLookup, createContextFulfiller, type HistoryMessage } from "../src/discord/context.ts";
import { createDiscordHistoryReader } from "../src/discord/gateway.ts";
import { scopeId } from "../src/types.ts";
import type { SurfaceContextQuery, SurfaceContextRequest, SurfaceContextResult } from "../src/reach/reach.ts";
import { noLinkChannels } from "./support/discord-channels.ts";

const CUR = "1300000000000000100";
const OPS = "1300000000000000200";
const VIEWER = "111";

const rows = (channel: string, base: number): HistoryMessage[] =>
  [1, 2].map((n) => ({
    id: String(base + n),
    authorId: "9",
    authorName: "Bob",
    authorIsBot: false,
    text: `${channel}-needle-${base + n}`,
    reactions: [],
  }));

interface Room {
  name: string;
  rows: HistoryMessage[];
  canView: boolean | undefined;
  botCanRead: boolean;
}

function discordTools(
  rooms: Record<string, Room>,
  roster?: Record<string, Array<{ displayName: string; type: string }>>,
  currentTarget = CUR,
  currentName = "general",
) {
  const recentCalls: string[] = [];
  const outcomes = new Map<string, { result?: SurfaceContextResult; error?: string }>();
  const core = {
    discordUserIdsFor: (v: string) => (v === "ana" ? [VIEWER] : []),
    fulfillContextRequest: async (id: string, outcome: { result?: SurfaceContextResult; error?: string }) => {
      outcomes.set(id, outcome);
    },
  };
  const fulfillContext = createContextFulfiller({
    core,
    botUserId: () => "bot",
    reader: {
      canView: async (id) => rooms[id]?.canView,
      recent: async (id) => {
        recentCalls.push(id);
        const room = rooms[id];
        if (!room?.botCanRead) throw new Error("not readable by the bot");
        return room.rows;
      },
    },
  });
  const lookup = createChannelLookup({
    core,
    reader: {
      canView: async (id) => rooms[id]?.canView,
      find: async (q) =>
        Object.entries(rooms)
          .filter(([id, r]) => id === q.replace(/^#/, "") || r.name === q.replace(/^#/, ""))
          .map(([id, r]) => ({ id, name: r.name })),
    },
    guard: {
      mayPost: async () => {
        throw new Error("a read must never consult the post guard");
      },
    },
  });
  let n = 0;
  const pull = async (query: SurfaceContextQuery): Promise<SurfaceContextResult | null> => {
    const id = `r${n++}`;
    const request = { id, source: "discord", createdAt: 0, status: "pending", query } satisfies SurfaceContextRequest;
    await (query.lookupChannel !== undefined ? lookup(request) : fulfillContext(request));
    const out = outcomes.get(id)!;
    return out.error ? { messages: [], note: out.error } : out.result!;
  };
  const tools = createSurfaceToolDeps({
    deps: {
      deliveries: {},
      directory: {
        resolve: async () => ({ kind: "none" }),
        resolveChannel: async () => ({ kind: "none" }),
        channelMember: async () => false,
        resolveGroupByParticipants: async () => ({ kind: "none" }),
        groupMember: async () => false,
        get: async () => ({ displayName: "Ana" }),
        conversationMembers: async (_kind: string, id: string) => roster?.[id],
      },
      surfaceContext: { pull: (_surface: string, q: SurfaceContextQuery) => pull(q) },
      discordLookup: pull,
    },
    input: { surfaceTools: true, surface: "discord" },
    actor: { id: "ana" },
    conversation: {
      kind: "channel",
      channelRef: CUR,
      channelName: currentName,
      audience: [{ type: "internal", id: "p1", displayName: "Conv" }],
    },
    session: { id: "S1" },
    scopeId: scopeId("personal", "ana"),
    defaultDestination: { type: "discord", target: currentTarget },
    strictReadOnly: false,
    provision: async () => ({}),
    blobTransfer: createMemoryBlobTransferStore(),
    fileRegistration: {},
    postProvenance: () => ({}),
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext)!;
  return { tools, recentCalls };
}

const THREAD = "1300000000000000150";

const world = (over: Partial<Room> = {}): Record<string, Room> => ({
  [THREAD]: { name: "a-thread", rows: rows("thr", 1500), canView: true, botCanRead: true },
  [CUR]: { name: "general", rows: rows("cur", 1000), canView: true, botCanRead: true },
  [OPS]: { name: "ops", rows: rows("ops", 2000), canView: true, botCanRead: true, ...over },
});

const texts = (r: { messages?: unknown[] }) => (r.messages as Array<{ text: string }>).map((m) => m.text);
const OPS_TEXTS = ["ops-needle-2001", "ops-needle-2002"];
const CUR_TEXTS = ["cur-needle-1001", "cur-needle-1002"];
const THREAD_TEXTS = ["thr-needle-1501", "thr-needle-1502"];

test("read_thread on another visible channel returns that channel, not the current one", async () => {
  const { tools, recentCalls } = discordTools(world());
  const r = await tools.readThread({ channel: "ops" });
  assert.equal(r.ok, true);
  assert.deepEqual(texts(r), OPS_TEXTS);
  assert.deepEqual(recentCalls, [OPS]);
});

test("read_thread without a channel, or naming the current one, reads the current conversation", async () => {
  for (const opts of [undefined, { channel: "general" }, { channel: CUR }]) {
    const { tools, recentCalls } = discordTools(world());
    const r = await tools.readThread(opts);
    assert.deepEqual(texts(r), CUR_TEXTS);
    assert.deepEqual(recentCalls, [CUR]);
  }
});

test("read_thread refuses a channel the caller cannot view and never falls back to the current one", async () => {
  const { tools, recentCalls } = discordTools(world({ canView: false }));
  const r = await tools.readThread({ channel: "ops" });
  assert.equal(r.ok, false);
  assert.equal(r.messages, undefined);
  assert.deepEqual(recentCalls, []);
});

test("read_thread reports a channel the bot cannot read instead of an empty ok", async () => {
  const { tools } = discordTools(world({ botCanRead: false }));
  const r = await tools.readThread({ channel: "ops" });
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /not readable/);
});

test("read_thread asks to retry while viewer permissions are still hydrating", async () => {
  const { tools, recentCalls } = discordTools(world({ canView: undefined }));
  const r = await tools.readThread({ channel: "ops" });
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /Try again/);
  assert.deepEqual(recentCalls, []);
});

test("read_thread on an unknown channel is an error, not the current conversation", async () => {
  const { tools, recentCalls } = discordTools(world());
  const r = await tools.readThread({ channel: "nowhere" });
  assert.equal(r.ok, false);
  assert.deepEqual(recentCalls, []);
});

test("read_thread rejects ts on Discord rather than ignoring it", async () => {
  const { tools, recentCalls } = discordTools(world());
  const r = await tools.readThread({ ts: "1300000000000000001" });
  assert.equal(r.ok, false);
  assert.deepEqual(recentCalls, []);
});

test("search scoped to a channel matches only that channel's messages", async () => {
  const { tools, recentCalls } = discordTools(world());
  const r = await tools.search("needle", { channel: "ops" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.hits?.map((h) => h.snippet).sort(), OPS_TEXTS);
  assert.deepEqual(recentCalls, [OPS]);
});

test("search on a channel the caller cannot view fails instead of searching the current one", async () => {
  const { tools, recentCalls } = discordTools(world({ canView: false }));
  const r = await tools.search("needle", { channel: "ops" });
  assert.equal(r.ok, false);
  assert.deepEqual(recentCalls, []);
});

test("search without a channel still searches the current conversation", async () => {
  const { tools } = discordTools(world());
  const r = await tools.search("needle");
  assert.deepEqual(r.hits?.map((h) => h.snippet).sort(), CUR_TEXTS);
});

test("read_members on another channel returns that channel's roster", async () => {
  const { tools } = discordTools(world(), {
    [OPS]: [
      { displayName: "Ana", type: "internal" },
      { displayName: "Guest", type: "external" },
    ],
  });
  const r = await tools.readMembers({ channel: "ops" });
  assert.deepEqual(r, { ok: true, members: [{ displayName: "Ana" }] });
});

test("read_members on a channel the caller cannot view errors instead of returning the current roster", async () => {
  const { tools } = discordTools(world({ canView: false }), { [OPS]: [{ displayName: "Eve", type: "internal" }] });
  const r = await tools.readMembers({ channel: "ops" });
  assert.equal(r.ok, false);
  assert.equal(r.members, undefined);
});

test("read_members on a visible channel with no synced roster errors instead of an empty list", async () => {
  const { tools } = discordTools(world());
  const r = await tools.readMembers({ channel: "ops" });
  assert.equal(r.ok, false);
});

test("the Discord history reader throws for a channel the bot cannot fetch", async () => {
  const client = { channels: { cache: new Map(), fetch: async () => null } };
  const reader = createDiscordHistoryReader({
    channels: noLinkChannels(client as unknown as Client),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  await assert.rejects(reader.recent("c1", { count: 5 }));
});

function slackTools(member: boolean, stored?: "cache") {
  const pulls: Array<Record<string, unknown>> = [];
  const cacheSearches: unknown[] = [];
  const tools = createSurfaceToolDeps({
    deps: {
      deliveries: {},
      directory: {
        resolve: async () => ({ kind: "none" }),
        resolveChannel: async (q: string) =>
          q === "random"
            ? { kind: "one", channel: { channelId: "C2", name: "random", isPrivate: true } }
            : { kind: "none" },
        channelMember: async () => member,
        resolveGroupByParticipants: async () => ({ kind: "none" }),
        groupMember: async () => false,
        get: async () => ({ displayName: "Ana" }),
      },
      ...(stored === "cache"
        ? {
            surfaceCache: {
              containerState: async () => null,
              search: async (_q: string, o: unknown) => {
                cacheSearches.push(o);
                return [];
              },
            },
          }
        : {}),
      surfaceContext: {
        pull: async (surface: string, q: SurfaceContextQuery) => {
          const { conversationTarget, channelId, threadTs } = q;
          pulls.push({
            surface,
            ...(conversationTarget ? { conversationTarget } : {}),
            ...(channelId ? { channelId } : {}),
            ...(threadTs ? { threadTs } : {}),
          });
          return { messages: [{ ts: "5.1", text: "hi" }] };
        },
      },
    },
    input: { surfaceTools: true, surface: "slack" },
    actor: { id: "ana" },
    conversation: { kind: "channel", channelRef: "C1", channelName: "general" },
    session: { id: "S1" },
    scopeId: scopeId("personal", "ana"),
    defaultDestination: { type: "slack", target: "C1:1.1" },
    strictReadOnly: false,
    provision: async () => ({}),
    blobTransfer: createMemoryBlobTransferStore(),
    fileRegistration: {},
    postProvenance: () => ({}),
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext)!;
  return { tools, pulls, cacheSearches };
}

test("Slack read_thread on another channel pulls that channel, and ts picks the thread", async () => {
  const { tools, pulls } = slackTools(true);
  assert.equal((await tools.readThread({ channel: "random" })).ok, true);
  assert.equal((await tools.readThread({ channel: "random", ts: "7.7" })).ok, true);
  assert.equal((await tools.readThread({ ts: "7.7" })).ok, true);
  assert.deepEqual(pulls, [
    { surface: "slack", channelId: "C2" },
    { surface: "slack", channelId: "C2", threadTs: "7.7" },
    { surface: "slack", conversationTarget: "C1:7.7", threadTs: "7.7" },
  ]);
});

test("Slack read_thread on a private channel the caller is not in errors without pulling", async () => {
  const { tools, pulls } = slackTools(false);
  const r = await tools.readThread({ channel: "random" });
  assert.equal(r.ok, false);
  assert.deepEqual(pulls, []);
});

test("naming the parent channel from inside a thread reads the parent, not the thread", async () => {
  const roster = { [CUR]: [{ displayName: "Parent", type: "internal" }] };
  const read = discordTools(world(), roster, THREAD);
  assert.deepEqual(texts(await read.tools.readThread({ channel: "general" })), CUR_TEXTS);
  assert.deepEqual(read.recentCalls, [CUR]);
  const search = discordTools(world(), roster, THREAD);
  assert.deepEqual(
    (await search.tools.search("needle", { channel: "general" })).hits?.map((h) => h.snippet).sort(),
    CUR_TEXTS,
  );
  assert.deepEqual(search.recentCalls, [CUR]);
  const bare = discordTools(world(), roster, THREAD);
  assert.deepEqual(texts(await bare.tools.readThread()), THREAD_TEXTS);
});

test("a channel id never matches the current channel by name, even when that name looks like the id", async () => {
  const { tools, recentCalls } = discordTools(world(), undefined, CUR, OPS);
  const r = await tools.readThread({ channel: OPS });
  assert.deepEqual(texts(r), OPS_TEXTS);
  assert.deepEqual(recentCalls, [OPS]);
});

test("Slack naming the parent channel from a thread sends channelId, so the named-channel checks run", async () => {
  const { tools, pulls } = slackTools(true);
  assert.equal((await tools.readThread({ channel: "general" })).ok, true);
  assert.deepEqual(pulls, [{ surface: "slack", channelId: "C1" }]);
});

test("read_members on the named current channel returns the conversation roster even without a synced directory roster", async () => {
  const { tools } = discordTools(world(), undefined, THREAD);
  assert.deepEqual(await tools.readMembers({ channel: "general" }), { ok: true, members: [{ displayName: "Conv" }] });
});

test("a #-prefixed channel id never matches the current channel by name", async () => {
  const { tools, recentCalls } = discordTools(world(), undefined, CUR, OPS);
  assert.deepEqual(texts(await tools.readThread({ channel: `#${OPS}` })), OPS_TEXTS);
  assert.deepEqual(recentCalls, [OPS]);
});

test("mirror-mode search refuses another channel instead of reading the stored mirror unchecked", async () => {
  const { tools, cacheSearches } = slackTools(true, "cache");
  const r = await tools.search("needle", { channel: "random" });
  assert.equal(r.ok, false);
  assert.deepEqual(cacheSearches, []);
  assert.equal((await tools.search("needle")).ok, true);
  assert.deepEqual(cacheSearches, [{ container: "C1", limit: 10 }]);
});
