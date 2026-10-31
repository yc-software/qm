import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUserClassifier,
  memberFacts,
  channelViewers,
  createChannelKind,
  createDiscordChannels,
  createDiscordHistoryReader,
  createStakeHistory,
  toInbound,
} from "../src/discord/gateway.ts";
import { withReplyContext } from "../src/discord/forwards.ts";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { DISCORD_AUDIENCE_CAP, channelReaders } from "../src/discord/readers.ts";
import { noLinkChannels } from "./support/discord-channels.ts";

const member = (id: string, roles: string[], bot = false, guildId = "900") => ({
  id,
  displayName: `u${id}`,
  user: { id, bot, globalName: null, username: `u${id}` },
  roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  guild: { id: guildId },
});

const guild = (id: string, members: Array<ReturnType<typeof member>>) => ({
  id,
  members: { cache: new Map(members.map((m) => [m.id, m])) },
});

const cfg = {
  botToken: "t",
  guildIds: new Set(["900", "901"]),
  internalRoleIds: new Set(["staff"]),
};

function classifier(
  allReady: boolean,
  guilds: Array<ReturnType<typeof guild>>,
  notInternal: (id: string) => boolean = () => false,
) {
  return createUserClassifier({
    client: { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } } as never,
    cfg,
    hydrator: { allReady: () => allReady },
    linkedInternal: async (id) => id === "3",
    coreStatus: async (id) => ({ notInternal: notInternal(id) }),
  });
}

test("a deactivated member with staff role is classified as a guest", async () => {
  const c = classifier(true, [guild("900", [member("2", ["staff"])])], (id) => id === "2");
  assert.equal((await c("2", "two"))!.isExternalGuest, true);
});

test("a staff role in any configured guild makes a DM user internal, regardless of guild order", async () => {
  const a = classifier(true, [guild("900", [member("2", [])]), guild("901", [member("2", ["staff"])])]);
  const b = classifier(true, [guild("901", [member("2", ["staff"])]), guild("900", [member("2", [])])]);
  assert.equal((await a("2", "two"))!.isExternalGuest, undefined);
  assert.deepEqual(await a("2", "two"), await b("2", "two"));
});

test("linked users are decided before hydration; others wait", async () => {
  const c = classifier(false, [guild("900", [])]);
  assert.equal((await c("3", "three"))!.isExternalGuest, undefined);
  assert.equal(await c("4", "four"), null);
});

test("after hydration an unknown user is a guest", async () => {
  const c = classifier(true, [guild("900", [])]);
  assert.equal((await c("4", "four"))!.isExternalGuest, true);
});

test("memberFacts extracts facts from a guild member", () => {
  const m = member("10", ["r1", "r2"], false);
  const facts = memberFacts(m as never);
  assert.deepEqual(facts, {
    userId: "10",
    displayName: "u10",
    roleIds: ["r1", "r2"],
    isBot: false,
  });
});

test("memberFacts excludes the role whose id equals the member guild id", () => {
  const m = member("10", ["r1", "900", "r2"], false, "900");
  const facts = memberFacts(m as never);
  assert.deepEqual(facts.roleIds, ["r1", "r2"]);
});

test("channelViewers returns not_a_guild_channel when channel is not in cache", async () => {
  const client = { channels: { cache: new Map() } };
  const res = await channelViewers(noLinkChannels(client), "unknown");
  assert.deepEqual(res, { ok: false, reason: "not_a_guild_channel" });
});

test("channelViewers returns viewers for a guild channel", async () => {
  const g = guild("900", [member("1", ["staff"]), member("2", [])]);
  const channel = {
    id: "c1",
    guild: g,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({ has: () => m.id === "1" }),
  };
  const client = { channels: { cache: new Map([["c1", channel]]) } };
  const res = await channelViewers(noLinkChannels(client), "c1");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.guildId, "900");
    assert.equal(res.members.length, 1);
    assert.equal(res.members[0]!.userId, "1");
  }
});

function threadsUnder(threadType: ChannelType, fetchMembers: () => Promise<Map<string, unknown>>) {
  const g = guild("900", [member("1", ["staff"]), member("2", ["staff"]), member("3", []), member("4", [])]);
  const parent = {
    id: "c1",
    guild: g,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (p: bigint | bigint[]) => m.id !== "4" && (p === PermissionFlagsBits.ManageThreads ? m.id === "2" : true),
    }),
  };
  const thread = {
    id: "t1",
    type: threadType,
    parent,
    parentId: "c1",
    guild: g,
    isThread: () => true,
    members: { fetch: fetchMembers },
  };
  return {
    channels: {
      cache: new Map<string, unknown>([
        ["c1", parent],
        ["t1", thread],
      ]),
    },
  };
}

test("a private thread's viewers are its members plus thread managers, never the rest of the parent", async () => {
  const client = threadsUnder(ChannelType.PrivateThread, async () => new Map([["1", {}]]));
  const res = await channelViewers(noLinkChannels(client), "t1");
  assert.deepEqual(res.ok && res.members.map((m) => m.userId), ["1", "2"]);
  const parent = await channelViewers(noLinkChannels(client), "c1");
  assert.deepEqual(parent.ok && parent.members.map((m) => m.userId), ["1", "2", "3"]);
  const publicThread = await channelViewers(
    noLinkChannels(threadsUnder(ChannelType.PublicThread, async () => new Map())),
    "t1",
  );
  assert.deepEqual(publicThread.ok && publicThread.members.map((m) => m.userId), ["1", "2", "3"]);
});

test("a private thread whose members cannot be fetched is unknown, and a deleted one is not a guild channel", async () => {
  const flaky = threadsUnder(ChannelType.PrivateThread, async () => {
    throw Object.assign(new Error("boom"), { status: 500 });
  });
  assert.deepEqual(await channelViewers(noLinkChannels(flaky), "t1"), { ok: false, reason: "members_not_ready" });
  const gone = threadsUnder(ChannelType.PrivateThread, async () => {
    throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
  });
  assert.deepEqual(await channelViewers(noLinkChannels(gone), "t1"), { ok: false, reason: "not_a_guild_channel" });
});

test("createChannelKind gates a private thread on the thread itself and a public thread on its parent", async () => {
  for (const [type, expected] of [
    [ChannelType.PrivateThread, "t1"],
    [ChannelType.PublicThread, "c1"],
  ] as const) {
    const client = threadsUnder(type, async () => new Map());
    const withFetch = { channels: { ...client.channels, fetch: async (id: string) => client.channels.cache.get(id) } };
    assert.deepEqual(await createChannelKind(noLinkChannels(withFetch))("t1"), {
      kind: "guild",
      baseChannelId: expected,
    });
  }
});

test("createChannelKind handles DM and guild channels", async () => {
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (id === "dm1") return { type: 1, recipientId: "u1" };
        if (id === "g1") {
          return {
            type: 0,
            isThread: () => false,
            id: "g1",
            guild: { id: "900" },
          };
        }
        return null;
      },
    },
  };
  const kindFn = createChannelKind(noLinkChannels(client));
  assert.deepEqual(await kindFn("dm1"), { kind: "dm", recipientId: "u1" });
  assert.deepEqual(await kindFn("g1"), { kind: "guild", baseChannelId: "g1" });
  assert.equal(await kindFn("missing"), null);
});

test("createStakeHistory fetches recent messages", async () => {
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (id !== "t1") return null;
        return {
          isTextBased: () => true,
          messages: {
            fetch: async () => new Map([["m1", { author: { id: "u1" }, mentions: { users: new Map([["bot", {}]]) } }]]),
          },
        };
      },
    },
  };
  const stakeHistory = createStakeHistory(noLinkChannels(client));
  const history = await stakeHistory("t1");
  assert.deepEqual(history, [{ authorId: "u1", mentionedUserIds: ["bot"] }]);
});

test("toInbound maps discord message correctly", () => {
  const fakeMsg = {
    id: "msg1",
    channelId: "c1",
    guildId: "g1",
    channel: { isThread: () => true, parentId: "parent1", name: "my-thread" },
    author: { id: "a1", username: "alice", bot: false, globalName: "Alice" },
    member: { displayName: "Alice D" },
    content: "hello world",
    mentions: { users: new Map([["bot1", {}]]) },
    attachments: new Map([
      ["att1", { url: "https://example.com/f.txt", name: "f.txt", contentType: "text/plain", size: 100 }],
    ]),
  };
  const inbound = toInbound(fakeMsg as never);
  assert.equal(inbound.id, "msg1");
  assert.equal(inbound.channelId, "c1");
  assert.equal(inbound.guildId, "g1");
  assert.equal(inbound.threadParentId, "parent1");
  assert.equal(inbound.channelName, "my-thread");
  assert.equal(inbound.authorId, "a1");
  assert.equal(inbound.authorName, "Alice D");
  assert.equal(inbound.authorIsBot, false);
  assert.equal(inbound.content, "hello world");
  assert.deepEqual(inbound.mentionedUserIds, ["bot1"]);
  assert.equal(inbound.attachments.length, 1);
});

const att = (name: string) => ({ url: `https://cdn/${name}`, name, contentType: "text/plain", size: 7 });
const baseMsg = {
  id: "m1",
  channelId: "c1",
  guildId: "g1",
  channel: { isThread: () => false, name: "eng" },
  author: { id: "a1", username: "alice", bot: false, globalName: null },
  member: null,
  mentions: { users: new Map() },
  attachments: new Map(),
};

test("toInbound renders forwarded snapshots after the text and carries their attachments", () => {
  const inbound = toInbound({
    ...baseMsg,
    content: "look at this",
    attachments: new Map([["a", att("mine.txt")]]),
    messageSnapshots: new Map([
      ["s1", { content: "original words", attachments: new Map([["b", att("theirs.txt")]]) }],
      ["s2", { content: "", attachments: new Map() }],
    ]),
  } as never);
  assert.equal(inbound.content, "look at this\n[forwarded message] original words\n[forwarded message]");
  assert.deepEqual(
    inbound.attachments.map((a) => a.name),
    ["mine.txt", "theirs.txt"],
  );
});

test("toInbound renders at most five forwarded snapshots", () => {
  const snapshots = new Map(
    Array.from({ length: 7 }, (_, i) => [`s${i}`, { content: `fw${i}`, attachments: new Map() }] as const),
  );
  const inbound = toInbound({ ...baseMsg, content: "x", messageSnapshots: snapshots } as never);
  assert.equal(inbound.content.split("\n").length, 6);
  assert.ok(inbound.content.includes("fw4"));
  assert.ok(!inbound.content.includes("fw5"));
});

test("toInbound with no snapshots leaves the content untouched", () => {
  assert.equal(toInbound({ ...baseMsg, content: "plain", messageSnapshots: new Map() } as never).content, "plain");
});

test("withReplyContext prefixes the referenced message with its author and a one-line excerpt", async () => {
  const msg = {
    reference: { messageId: "p1", type: 0 },
    fetchReference: async () => ({
      member: { displayName: "Bo" },
      author: { globalName: null, username: "bo" },
      content: "  the build\nis   red ",
    }),
  };
  assert.equal(await withReplyContext(msg as never, "why?", "bot1"), "[in reply to Bo] the build is red\nwhy?");
});

test("withReplyContext labels the bot's own message as you, not by its display name", async () => {
  const msg = {
    reference: { messageId: "p1", type: 0 },
    fetchReference: async () => ({
      member: { displayName: "LogicalGuard" },
      author: { id: "bot1", globalName: null, username: "LogicalGuard" },
      content: "I can't answer here",
    }),
  };
  assert.equal(
    await withReplyContext(msg as never, "and now?", "bot1"),
    "[in reply to you] I can't answer here\nand now?",
  );
});

test("withReplyContext clips a long referenced message", async () => {
  const msg = {
    reference: { messageId: "p1", type: 0 },
    fetchReference: async () => ({
      member: null,
      author: { globalName: "Bo", username: "bo" },
      content: "z".repeat(400),
    }),
  };
  assert.equal(await withReplyContext(msg as never, "ok", "bot1"), `[in reply to Bo] ${"z".repeat(300)}…\nok`);
});

test("withReplyContext leaves text alone for plain messages, forwards and unreadable references", async () => {
  let fetched = 0;
  const fetchReference = async () => {
    fetched += 1;
    throw new Error("Unknown Message");
  };
  assert.equal(await withReplyContext({ reference: null, fetchReference } as never, "t", "bot1"), "t", "bot1");
  assert.equal(
    await withReplyContext({ reference: { messageId: "p1", type: 1 }, fetchReference } as never, "t", "bot1"),
    "t",
    "bot1",
  );
  assert.equal(fetched, 0);
  assert.equal(
    await withReplyContext({ reference: { messageId: "p1", type: 0 }, fetchReference } as never, "t", "bot1"),
    "t",
    "bot1",
  );
  assert.equal(fetched, 1);
});

test("history rows include forwarded snapshot text", async () => {
  const messages = new Map([
    [
      "1300000000000000001",
      {
        id: "1300000000000000001",
        content: "fyi",
        author: { id: "1", globalName: null, username: "alice", bot: false },
        messageSnapshots: new Map([["s", { content: "inner", attachments: new Map() }]]),
        reactions: { cache: new Map() },
      },
    ],
  ]);
  const channel = {
    id: "c1",
    isTextBased: () => true,
    isThread: () => false,
    messages: { fetch: async () => messages },
  };
  const reader = createDiscordHistoryReader({
    channels: noLinkChannels({ channels: { cache: new Map([["c1", channel]]), fetch: async () => channel } } as never),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  const rows = await reader.recent("c1", { count: 5 });
  assert.equal(rows[0]!.text, "fyi\n[forwarded message] inner");
});

test("every channel the gateway resolves links a private thread before returning it, and fails when the link cannot be written", async () => {
  const thread = (id: string, type: ChannelType) => ({
    id,
    type,
    parentId: "c1",
    name: id,
    guildId: "g1",
    isTextBased: () => true,
  });
  const cache = new Map([
    ["p1", thread("p1", ChannelType.PrivateThread)],
    ["u1", thread("u1", ChannelType.PublicThread)],
  ]);
  const client = {
    channels: { cache, fetch: async (id: string) => cache.get(id) ?? thread(id, ChannelType.PrivateThread) },
  };
  const links: string[] = [];
  const channels = createDiscordChannels(client as never, async (threadId, parentId) => {
    links.push(`${threadId}>${parentId}`);
  });
  await channels.fetch("p2");
  await channels.cached("p1");
  await channels.cached("u1");
  await channels.fetch("u1");
  assert.deepEqual(links, ["p2>c1", "p1>c1"]);
  const failing = createDiscordChannels(client as never, async () => {
    throw new Error("store down");
  });
  await assert.rejects(failing.fetch("p2"), /store down/);
  await assert.rejects(failing.cached("p1"), /store down/);
  const reader = (on: typeof channels) =>
    createDiscordHistoryReader({ channels: on, guildIds: new Set(["g1"]), hydrator: { ready: () => true } });
  links.length = 0;
  assert.deepEqual(await reader(channels).find("p1"), [{ id: "p1", name: "p1" }]);
  assert.deepEqual(links, ["p1>c1"]);
  await assert.rejects(reader(failing).find("p1"), /store down/);
  assert.deepEqual(await channelViewers(failing, "p1"), { ok: false, reason: "members_not_ready" });
});

test("channelViewers stops scanning past the audience cap and the readers come back as too many", async () => {
  const members = Array.from({ length: DISCORD_AUDIENCE_CAP * 3 }, (_, i) => member(String(1000 + i), []));
  const g = guild("900", members);
  let checked = 0;
  const channel = {
    id: "c1",
    guild: g,
    isThread: () => false,
    permissionsFor: () => {
      checked += 1;
      return { has: () => true };
    },
  };
  const viewers = await channelViewers(noLinkChannels({ channels: { cache: new Map([["c1", channel]]) } }), "c1");
  assert.ok(checked <= DISCORD_AUDIENCE_CAP + 2, `checked ${checked} members`);
  const readers = await channelReaders({
    viewers,
    guildIds: new Set(["900"]),
    ready: () => true,
    botUserId: "bot",
    classify: async () => assert.fail("must not classify an over-cap audience"),
  });
  assert.deepEqual(readers, { ok: false, retry: false, reason: "too_many_readers" });
});

test("an audience of exactly the cap plus the bot is still readable", async () => {
  const members = [
    ...Array.from({ length: DISCORD_AUDIENCE_CAP }, (_, i) => member(String(1000 + i), [])),
    member("bot", [], true),
  ];
  const channel = {
    id: "c1",
    guild: guild("900", members),
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const viewers = await channelViewers(noLinkChannels({ channels: { cache: new Map([["c1", channel]]) } }), "c1");
  const readers = await channelReaders({
    viewers,
    guildIds: new Set(["900"]),
    ready: () => true,
    botUserId: "bot",
    classify: async (m) => ({ externalId: m.userId }) as never,
  });
  assert.equal(readers.ok, true);
});

test("a bot among the first permitted members cannot hide a larger audience behind the cap", async () => {
  const humans = (from: number, n: number) => Array.from({ length: n }, (_, i) => member(String(from + i), []));
  const members = [
    ...humans(1000, DISCORD_AUDIENCE_CAP),
    member("bot", [], true),
    ...humans(5000, DISCORD_AUDIENCE_CAP),
  ];
  const channel = {
    id: "c1",
    guild: guild("900", members),
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const viewers = await channelViewers(noLinkChannels({ channels: { cache: new Map([["c1", channel]]) } }), "c1");
  const readers = await channelReaders({
    viewers,
    guildIds: new Set(["900"]),
    ready: () => true,
    botUserId: "bot",
    classify: async () => assert.fail("must not classify an over-cap audience"),
  });
  assert.deepEqual(readers, { ok: false, retry: false, reason: "too_many_readers" });
});
