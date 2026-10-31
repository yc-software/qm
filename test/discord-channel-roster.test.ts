import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createDiscordCoreClient } from "../src/api/discord-core-client.ts";
import { createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { resolveReachTarget } from "../src/reach/reach.ts";
import {
  computeDiscordRoster,
  createChannelRosterSync,
  DISCORD_ROSTER_ATTEMPTS,
  DISCORD_ROSTER_KEEP_MS,
  syncDirectoryAndRosters,
  type DiscordRoster,
} from "../src/discord/channel-roster.ts";
import { channelReaders } from "../src/discord/readers.ts";
import { createDeliveryGuard } from "../src/discord/deliveries.ts";
import { channelViewers } from "../src/discord/gateway.ts";
import type { ChannelMembership, DirectoryChannel } from "../src/directory/directory-store.ts";
import type { ActorAssertion } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { noLinkChannels } from "./support/discord-channels.ts";
import { testConfig } from "./support/test-config.ts";

afterEach(() => {
  installPrincipalLinks(null);
  mock.restoreAll();
});

const GUILD = "900";
const PUBLIC = "100000000000000201";
const PRIVATE = "100000000000000202";
const THREAD = "100000000000000203";
const GONE = "100000000000000204";

const OWN_BOT = "6";

const actors: Record<string, ActorAssertion> = {
  "1": { externalId: "discord:1", displayName: "Ada" },
  "2": { externalId: "discord:2", displayName: "Bo" },
  "3": { externalId: "discord:3", displayName: "Guest", isExternalGuest: true },
  "4": { externalId: "discord:4", displayName: "Pending" },
  "5": { externalId: "discord:5", displayName: "Robot", isBot: true, isExternalGuest: true },
  "7": { externalId: "discord:7", displayName: "Pending guest", isExternalGuest: true },
};

const pendingIds = new Set(["4", "7"]);
const botIds = new Set(["5", OWN_BOT]);

const facts = (id: string, guildId: string) => ({
  id,
  displayName: actors[id]?.displayName ?? id,
  user: { id, bot: botIds.has(id), globalName: null, username: `u${id}` },
  roles: { cache: new Map() },
  guild: { id: guildId },
  ...(pendingIds.has(id) ? { pending: true } : {}),
});

const guildOf = (id: string, ids: string[]) => {
  const members = ids.map((m) => facts(m, id));
  return { id, members: { cache: new Map(members.map((m) => [m.id, m])) }, list: members };
};

const viewOnly = new Set<string>();

const ALL = ["1", "2", "3", "4", "5", OWN_BOT, "7"];
const guild = guildOf(GUILD, ALL);
const otherGuild = guildOf("901", ["1", "2"]);

function guildChannel(
  id: string,
  name: string,
  viewers: string[],
  type: ChannelType = ChannelType.GuildText,
  g: typeof guild = guild,
) {
  return {
    id,
    name,
    type,
    guildId: g.id,
    guild: g,
    isTextBased: () => true,
    isDMBased: () => false,
    isVoiceBased: () => false,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => ({
      has: (flags: bigint | bigint[]) =>
        [flags]
          .flat()
          .every(
            (flag) =>
              viewers.includes(m.id) &&
              (flag === PermissionFlagsBits.ViewChannel ||
                (flag === PermissionFlagsBits.ReadMessageHistory && !viewOnly.has(m.id))),
          ),
    }),
  };
}

function rosterDeps(
  channelList: unknown[],
  opts: { counted?: string[]; ready?: string[]; lastMembersOk?: Map<string, number> } = {},
) {
  const client = { channels: { cache: new Map((channelList as Array<{ id: string }>).map((c) => [c.id, c])) } };
  return {
    channels: noLinkChannels(client),
    guildIds: new Set([GUILD, otherGuild.id]),
    ready: (guildId: string) => (opts.ready ?? [GUILD, otherGuild.id]).includes(guildId),
    botUserId: OWN_BOT,
    lastMembersOk: opts.lastMembersOk ?? new Map<string, number>(),
    classify: async (id: string) => {
      opts.counted?.push(id);
      return actors[id] ?? { externalId: `discord:${id}`, displayName: id, isBot: true, isExternalGuest: true };
    },
  };
}

const rosterOf = async (deps: Parameters<typeof computeDiscordRoster>[0]) => (await computeDiscordRoster(deps)).roster;

const privateThread = (id: string, viewers: string[], fetchMembers: () => Promise<Map<string, object>>) => ({
  ...guildChannel(id, "side", viewers, ChannelType.PrivateThread),
  isThread: () => true,
  parent: guildChannel(PRIVATE, "x", viewers),
  members: { fetch: fetchMembers },
});

test("every Discord channel is membership-only, and the roster keeps pending members off it", async () => {
  const roster = await rosterOf(
    rosterDeps([
      guildChannel(PUBLIC, "general", ["1", "2", "4", OWN_BOT]),
      guildChannel(PRIVATE, "leads", ["1", "4"]),
      privateThread(THREAD, ["1", "2"], async () => new Map([["1", {}]])),
    ]),
  );
  assert.deepEqual(roster, {
    channels: [
      { channelId: PUBLIC, name: "general", isPrivate: true },
      { channelId: PRIVATE, name: "leads", isPrivate: true },
      { channelId: THREAD, name: "side", isPrivate: true },
    ],
    keep: [],
    members: [
      { channelId: PUBLIC, principalId: "discord:1" },
      { channelId: PUBLIC, principalId: "discord:2" },
      { channelId: PRIVATE, principalId: "discord:1" },
      { channelId: THREAD, principalId: "discord:1" },
    ],
  });
});

test("a guest, a third-party bot or a pending guest viewing it exposes it", async () => {
  const everyoneInternal = ["1", "2", "4", OWN_BOT];
  const exposure = async (extra: string[]) => {
    const roster = await rosterOf(rosterDeps([guildChannel(PUBLIC, "general", [...everyoneInternal, ...extra])]));
    return roster.channels[0]!;
  };
  assert.equal((await exposure(["3", "5", "7"])).isPrivate, true);
  assert.equal((await exposure([])).isExternal, undefined);
  assert.equal((await exposure(["3"])).isExternal, true);
  assert.equal((await exposure(["5"])).isExternal, true);
  assert.equal((await exposure(["7"])).isExternal, true);
  const withGrants = await rosterOf(
    rosterDeps([guildChannel(PUBLIC, "general", [...everyoneInternal, "3", "5", "7"])]),
  );
  assert.deepEqual(
    withGrants.members.map((m) => m.principalId),
    ["discord:1", "discord:2"],
  );
});

test("each member is classified once per recompute across channels and guilds", async () => {
  const counted: string[] = [];
  await computeDiscordRoster(
    rosterDeps(
      [
        guildChannel(PUBLIC, "general", ["1", "2", "3"]),
        guildChannel(PRIVATE, "leads", ["1", "3"]),
        guildChannel(GONE, "other", ["1", "2"], ChannelType.GuildText, otherGuild as never),
      ],
      { counted },
    ),
  );
  assert.deepEqual(counted.sort(), ["1", "2", "3"]);
});

test("a private thread whose members cannot be fetched is left out while other channels proceed", async () => {
  const roster = await rosterOf(
    rosterDeps([
      guildChannel(PUBLIC, "general", ["1", "2"]),
      privateThread(THREAD, ["1"], async () => {
        throw new Error("rate limited");
      }),
    ]),
  );
  assert.deepEqual(
    roster.channels.map((c) => c.channelId),
    [PUBLIC],
  );
});

test("a guild whose members are not hydrated contributes no channels", async () => {
  const roster = await rosterOf(
    rosterDeps(
      [
        guildChannel(PUBLIC, "general", ["1", "2"]),
        guildChannel(PRIVATE, "other", ["1"], ChannelType.GuildText, otherGuild as never),
      ],
      { ready: ["901"] },
    ),
  );
  assert.deepEqual(
    roster.channels.map((c) => c.channelId),
    [PRIVATE],
  );
});

const emptyRoster: DiscordRoster = { channels: [], members: [], keep: [] };

function syncHarness(over: Partial<Parameters<typeof createChannelRosterSync>[0]> = {}) {
  const stamps: number[] = [];
  let computes = 0;
  const sync = createChannelRosterSync({
    compute: async () => (computes++, { roster: emptyRoster, unready: false, skipped: false, fetched: [] }),
    hold: (fn) => fn(new Promise(() => {})),
    push: async (_roster, at) => (stamps.push(at), true),
    lastMembersOk: new Map<string, number>(),
    retryMs: 0,
    ...over,
  });
  return { sync, stamps, computes: () => computes };
}

test("an event that arrives while a sync is running triggers one more run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let computes = 0;
  const { sync } = syncHarness({
    compute: async () => {
      computes += 1;
      if (computes === 1) await gate;
      return { roster: emptyRoster, unready: false, skipped: false, fetched: [] };
    },
  });
  const first = sync();
  await new Promise((r) => setImmediate(r));
  const second = sync();
  const third = sync();
  release();
  await Promise.all([first, second, third]);
  assert.equal(computes, 2);
});

test("a refused push is retried with a strictly newer stamp, even within one millisecond", async () => {
  mock.method(Date, "now", () => 5_000);
  const results = [false, false, true];
  const stamps: number[] = [];
  const { sync } = syncHarness({
    push: async (_r, at) => {
      stamps.push(at);
      return results.shift()!;
    },
  });
  await sync();
  assert.deepEqual(stamps, [5_000, 5_001, 5_002]);
});

test("a sync that keeps failing gives up after the attempt budget and runs again on the next event", async () => {
  const h = syncHarness({ hold: async () => null });
  await h.sync();
  assert.equal(h.stamps.length, 0);
  let holds = 0;
  const counting = syncHarness({ hold: async () => (holds++, null) });
  await counting.sync();
  assert.equal(holds, DISCORD_ROSTER_ATTEMPTS);
  await counting.sync();
  assert.equal(holds, DISCORD_ROSTER_ATTEMPTS * 2);
});

test("directory and roster passes both run, and a failing directory pass does not skip the roster", async () => {
  let rosters = 0;
  const warn = mock.method(console, "warn", () => {});
  await syncDirectoryAndRosters(
    async () => {
      throw new Error("directory down");
    },
    async () => void rosters++,
  )();
  assert.equal(rosters, 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /directory down/);
});

test("giving up after the attempt budget is logged", async () => {
  const warn = mock.method(console, "warn", () => {});
  await syncHarness({ hold: async () => null }).sync();
  assert.ok(warn.mock.calls.some((c) => /gave up/.test(String(c.arguments[0]))));
});

function builtDiscord() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "discord-roster-")) }));
  const core = createDiscordCoreClient({
    app: built.app,
    identity: built.identity,
    runs: { onTerminal: () => {} },
  } as never);
  return { built, core };
}

const syncChannels = (
  core: ReturnType<typeof builtDiscord>["core"],
  roster: { channels: DirectoryChannel[]; members: ChannelMembership[]; keep?: string[] },
  at: number,
) => core.syncChannels({ keep: [], ...roster }, at);

const person = (id: string) => ({
  principalId: `discord:${id}`,
  displayName: actors[id]!.displayName ?? id,
  type: "internal" as const,
});

test("a synced Discord roster lets a non-admin internal member use sandbox and capability routes, and nobody else", async () => {
  const { built, core } = builtDiscord();
  await core.syncDirectory([person("1"), person("2")]);
  const at = Date.now();
  await syncChannels(
    core,
    {
      channels: [
        { channelId: PUBLIC, name: "general", isPrivate: true },
        { channelId: PRIVATE, name: "leads", isPrivate: true },
      ],
      members: [
        { channelId: PUBLIC, principalId: "discord:1" },
        { channelId: PUBLIC, principalId: "discord:2" },
        { channelId: PRIVATE, principalId: "discord:1" },
      ],
    },
    at,
  );
  const canWrite = createCanWriteScope({ directory: built.directory, identity: built.identity } as never);
  const cap = (actorId: string, channel: string) =>
    built.app.authorizesCapabilityScope({ actorId, scopeId: `channel:${channel}` });
  assert.equal(await canWrite("discord:1", `channel:${PRIVATE}`), true);
  assert.equal(await cap("discord:1", PRIVATE), true);
  assert.equal(await canWrite("discord:2", `channel:${PRIVATE}`), false);
  assert.equal(await cap("discord:2", PRIVATE), false);
  assert.equal(await canWrite("discord:2", `channel:${PUBLIC}`), true);
  assert.equal(await cap("discord:2", PUBLIC), true);
  assert.equal(await canWrite("discord:3", `channel:${PUBLIC}`), false);
  await core.syncDirectory([
    person("1"),
    person("2"),
    { ...person("1"), principalId: "discord:9", displayName: "Other guild" },
  ]);
  await built.app.upsertDirectory([{ principalId: "U-ana", displayName: "Ana", type: "internal" }]);
  for (const outsider of ["discord:9", "U-ana"]) {
    assert.equal(await canWrite(outsider, `channel:${PUBLIC}`), false);
    assert.equal(await cap(outsider, PUBLIC), false);
    assert.equal(await built.app.channelVisibleTo(outsider, PUBLIC, true), false);
  }
});

test("an external guest in a private channel switches sandbox off for its members, who stay listed", async () => {
  const { built, core } = builtDiscord();
  await core.syncDirectory([person("1")]);
  await syncChannels(
    core,
    {
      channels: [{ channelId: PRIVATE, name: "leads", isPrivate: true, isExternal: true }],
      members: [{ channelId: PRIVATE, principalId: "discord:1" }],
    },
    Date.now(),
  );
  const canWrite = createCanWriteScope({ directory: built.directory, identity: built.identity } as never);
  assert.equal(await canWrite("discord:1", `channel:${PRIVATE}`), false);
  assert.equal(await built.directory.channelMembership(PRIVATE, "discord:1"), true);
});

test("a channel missing from the live inventory, and an empty inventory, are deleted without touching Slack", async () => {
  const { built, core } = builtDiscord();
  await built.app.upsertChannels([{ channelId: "C-ops", name: "ops" }], [], Date.now());
  await core.syncDirectory([person("1")]);
  const base = Date.now();
  await syncChannels(
    core,
    {
      channels: [
        { channelId: PUBLIC, name: "general" },
        { channelId: GONE, name: "old", isPrivate: false },
      ],
      members: [
        { channelId: PUBLIC, principalId: "discord:1" },
        { channelId: GONE, principalId: "discord:1" },
      ],
    },
    base,
  );
  await syncChannels(
    core,
    { channels: [{ channelId: PUBLIC, name: "general" }], members: [{ channelId: PUBLIC, principalId: "discord:1" }] },
    base + 1,
  );
  assert.equal(await built.directory.channelMemberIds(GONE), undefined);
  assert.equal(await built.directory.channelMember(GONE, "discord:1"), false);
  assert.deepEqual(await built.directory.channelMemberIds(PUBLIC), ["discord:1"]);
  await syncChannels(core, { channels: [], members: [] }, base + 2);
  assert.deepEqual(
    (await built.directory.listChannels()).map((c) => c.channelId),
    ["C-ops"],
  );
});

test("a Discord sync leaves Slack channels alone and reach routes a Discord channel to Discord beside a same-named Slack one", async () => {
  const { built, core } = builtDiscord();
  await built.app.upsertDirectory([{ principalId: "U-ana", displayName: "Ana", type: "internal" }]);
  await built.app.upsertChannels(
    [{ channelId: "C-ops", name: "ops" }],
    [{ channelId: "C-ops", principalId: "U-ana" }],
    Date.now(),
  );
  await core.syncDirectory([person("1")]);
  await syncChannels(
    core,
    {
      channels: [{ channelId: PUBLIC, name: "ops", isPrivate: false }],
      members: [{ channelId: PUBLIC, principalId: "discord:1" }],
    },
    Date.now() + 1,
  );
  assert.equal(
    (await built.directory.listChannels()).some((c) => c.channelId === "C-ops"),
    true,
  );
  const dir = {
    resolveRecipient: async () => ({ kind: "none" as const }),
    resolveChannel: (q: string) => built.directory.resolveChannel(q),
    channelMember: (c: string, p: string) => built.directory.channelMember(c, p),
    resolveGroup: async () => ({ kind: "none" as const }),
    groupMember: async () => false,
    directoryMember: async () => ({ type: "internal" as const }),
    discordLookup: async (query: { lookupChannel?: string }) => ({
      messages: [] as [],
      channel: { channelId: query.lookupChannel ?? "", name: "ops" },
    }),
  };
  const viaId = await resolveReachTarget(dir, { channel: PUBLIC }, "discord:1");
  assert.equal(viaId.ok && viaId.destination.type, "discord");
  assert.equal(viaId.ok && viaId.destination.target, PUBLIC);
  const viaName = await resolveReachTarget(dir, { channel: "ops" }, "U-ana");
  assert.equal(viaName.ok === false && viaName.error, "ambiguous_channel");
  const slack = await resolveReachTarget(dir, { channel: "C-ops" }, "U-ana");
  assert.equal(slack.ok && slack.destination.type, "slack");
});

test("a stored Discord channel is only routed to when the Discord lookup confirms the caller can view it", async () => {
  const { built, core } = builtDiscord();
  await syncChannels(
    core,
    { channels: [{ channelId: PUBLIC, name: "general", isPrivate: false }], members: [] },
    Date.now(),
  );
  const asked: string[] = [];
  const dirWith = (found: { messages: []; channel?: { channelId: string; name: string }; note?: string } | null) => ({
    resolveRecipient: async () => ({ kind: "none" as const }),
    resolveChannel: (q: string) => built.directory.resolveChannel(q),
    channelMember: (c: string, p: string) => built.directory.channelMember(c, p),
    resolveGroup: async () => ({ kind: "none" as const }),
    groupMember: async () => false,
    directoryMember: async () => ({ type: "internal" as const }),
    discordLookup: async (query: { lookupChannel?: string; viewer?: string }) => {
      asked.push(`${query.lookupChannel}|${query.viewer}`);
      return found;
    },
  });
  const outsider = await resolveReachTarget(dirWith({ messages: [] }), { channel: "general" }, "U-outsider");
  assert.equal(outsider.ok, false);
  assert.deepEqual(asked, [`${PUBLIC}|U-outsider`]);
  const member = await resolveReachTarget(
    dirWith({ messages: [], channel: { channelId: PUBLIC, name: "general" } }),
    { channel: "general" },
    "discord:1",
  );
  assert.equal(member.ok && member.destination.type, "discord");
});

test("an unhydrated guild is never pushed, so a reconnect cannot delete its stored rows", async () => {
  const warn = mock.method(console, "warn", () => {});
  const { built, core } = builtDiscord();
  await core.syncDirectory([person("1")]);
  await syncChannels(
    core,
    {
      channels: [{ channelId: PRIVATE, name: "leads", isPrivate: true }],
      members: [{ channelId: PRIVATE, principalId: "discord:1" }],
    },
    Date.now(),
  );
  const pushed: DiscordRoster[] = [];
  const sync = createChannelRosterSync({
    compute: () => computeDiscordRoster(rosterDeps([guildChannel(PUBLIC, "general", ["1"])], { ready: [GUILD] })),
    hold: (fn) => fn(new Promise(() => {})),
    push: async (roster, at) => (pushed.push(roster), core.syncChannels(roster, at)),
    retryMs: 0,
    lastMembersOk: new Map(),
  });
  await sync();
  assert.equal(pushed.length, 0);
  assert.deepEqual(
    (await built.directory.listChannels()).map((c) => c.channelId),
    [PRIVATE],
  );
  assert.ok(warn.mock.calls.some((c) => /guilds not hydrated, roster not pushed: 901/.test(String(c.arguments[0]))));
});

test("a private thread whose members cannot be fetched keeps its stored row within the bound, and the sync retries", async () => {
  const { built, core } = builtDiscord();
  await core.syncDirectory([person("1")]);
  await syncChannels(
    core,
    {
      channels: [{ channelId: THREAD, name: "t", isPrivate: true }],
      members: [{ channelId: THREAD, principalId: "discord:1" }],
    },
    Date.now(),
  );
  const thread = privateThread(THREAD, ["1"], async () => {
    throw new Error("rate limited");
  });
  const lastMembersOk = new Map([[THREAD, Date.now() - DISCORD_ROSTER_KEEP_MS + 60_000]]);
  const computed = await computeDiscordRoster(
    rosterDeps([guildChannel(PUBLIC, "general", ["1"]), thread], { lastMembersOk }),
  );
  assert.deepEqual(computed.roster.keep, [THREAD]);
  assert.equal(computed.unready, false);
  let computes = 0;
  const sync = createChannelRosterSync({
    compute: async () => (computes++, computed),
    hold: (fn) => fn(new Promise(() => {})),
    push: (roster, at) => core.syncChannels(roster, at),
    retryMs: 0,
    lastMembersOk: new Map(),
  });
  await sync();
  assert.equal(computes, DISCORD_ROSTER_ATTEMPTS);
  assert.deepEqual((await built.directory.listChannels()).map((c) => c.channelId).sort(), [PUBLIC, THREAD].sort());
  assert.deepEqual(await built.directory.channelMemberIds(THREAD), ["discord:1"]);
});

test("a thread whose last successful member fetch is older than the bound, or unknown, is dropped from the roster", async () => {
  const { built, core } = builtDiscord();
  await core.syncDirectory([person("1")]);
  await syncChannels(
    core,
    {
      channels: [{ channelId: THREAD, name: "t", isPrivate: true }],
      members: [{ channelId: THREAD, principalId: "discord:1" }],
    },
    Date.now(),
  );
  const failing = () =>
    privateThread(THREAD, ["1"], async () => {
      throw new Error("rate limited");
    });
  for (const lastMembersOk of [
    new Map<string, number>(),
    new Map([[THREAD, Date.now() - DISCORD_ROSTER_KEEP_MS - 1_000]]),
  ]) {
    const computed = await computeDiscordRoster(
      rosterDeps([guildChannel(PUBLIC, "general", ["1"]), failing()], { lastMembersOk }),
    );
    assert.deepEqual(computed.roster.keep, []);
    assert.equal(computed.skipped, true);
  }
  await syncChannels(core, { channels: [], members: [], keep: [] }, Date.now() + 10);
  assert.deepEqual(await built.directory.listChannels(), []);
});

test("a stored Discord channel with no Discord lookup is denied, not judged by the directory", async () => {
  const { built, core } = builtDiscord();
  await syncChannels(
    core,
    { channels: [{ channelId: PUBLIC, name: "general", isPrivate: false }], members: [] },
    Date.now(),
  );
  const dir = {
    resolveRecipient: async () => ({ kind: "none" as const }),
    resolveChannel: (q: string) => built.directory.resolveChannel(q),
    channelMember: async () => true,
    resolveGroup: async () => ({ kind: "none" as const }),
    groupMember: async () => false,
    directoryMember: async () => ({ type: "internal" as const }),
  };
  assert.equal((await resolveReachTarget(dir, { channel: "general" }, "U-ana")).ok, false);
});

test("a view-only guest still counts as a reader and exposes the channel, while a view-only member is off the roster", async () => {
  viewOnly.add("2");
  viewOnly.add("3");
  try {
    const list = [guildChannel(PRIVATE, "leads", ["1", "2", "3"])];
    const { roster } = await computeDiscordRoster(rosterDeps(list));
    assert.deepEqual(
      roster.members.map((m) => m.principalId),
      ["discord:1"],
    );
    assert.equal(roster.channels[0]?.isExternal, true);
    const viewers = await channelViewers(
      noLinkChannels({ channels: { cache: new Map([[PRIVATE, list[0]]]) } }),
      PRIVATE,
    );
    assert.deepEqual(viewers.ok && viewers.members.map((m) => m.userId).sort(), ["1", "2", "3"]);
  } finally {
    viewOnly.clear();
  }
});

test("the delivery guard still refuses a channel a view-only guest can read", async () => {
  viewOnly.add("3");
  try {
    const list = [guildChannel(PRIVATE, "leads", ["1", "3"])];
    const channels = noLinkChannels({ channels: { cache: new Map([[PRIVATE, list[0]]]) } });
    const guard = createDeliveryGuard({
      channelKind: async () => ({ kind: "channel", baseChannelId: PRIVATE }) as never,
      readers: async (id) =>
        channelReaders({
          viewers: await channelViewers(channels, id),
          guildIds: new Set([GUILD]),
          ready: () => true,
          botUserId: OWN_BOT,
          classify: async (m) => actors[m.userId]!,
        }),
      classifyUser: async () => null,
    });
    assert.deepEqual(await guard.mayPost(PRIVATE), { ok: false, retry: false, reason: "guest reader" });
  } finally {
    viewOnly.clear();
  }
});

test("a thread's member-fetch time is recorded only after the push is accepted", async () => {
  const lastMembersOk = new Map<string, number>();
  const accepted = [false, true];
  const sync = createChannelRosterSync({
    compute: async () => ({ roster: emptyRoster, unready: false, skipped: false, fetched: [THREAD] }),
    hold: (fn) => fn(new Promise(() => {})),
    push: async () => {
      assert.equal(lastMembersOk.has(THREAD), false);
      return accepted.shift()!;
    },
    lastMembersOk,
    retryMs: 0,
  });
  await sync();
  assert.equal(lastMembersOk.has(THREAD), true);
  const refused = new Map<string, number>();
  await createChannelRosterSync({
    compute: async () => ({ roster: emptyRoster, unready: false, skipped: false, fetched: [THREAD] }),
    hold: (fn) => fn(new Promise(() => {})),
    push: async () => false,
    lastMembersOk: refused,
    retryMs: 0,
  })();
  assert.equal(refused.size, 0);
});
