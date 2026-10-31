import assert from "node:assert/strict";
import { after, before, describe, it, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { resolveReachTarget, type ReachDirectory } from "../src/reach/reach.ts";
import { createChannelLookup } from "../src/discord/context.ts";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createDiscordHistoryReader } from "../src/discord/gateway.ts";
import { destinationVisible, runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { createControlService } from "../src/api/control-service.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeActor, scopeId } from "../src/types.ts";
import type { SurfaceContextQuery, SurfaceContextRequest, SurfaceContextResult } from "../src/reach/reach.ts";
import { installDiscord, noLinkChannels } from "./support/discord-channels.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";

const SLACK_CHANNEL = { channelId: "C-eng", name: "eng" };

function directory(lookup?: ReachDirectory["discordLookup"]): ReachDirectory {
  return {
    resolveRecipient: async () => ({ kind: "none" }),
    resolveChannel: async (q) => (q === "eng" ? { kind: "one", channel: SLACK_CHANNEL } : { kind: "none" }),
    channelMember: async () => false,
    resolveGroup: async () => ({ kind: "none" }),
    groupMember: async () => false,
    directoryMember: async () => ({ type: "internal" }),
    ...(lookup ? { discordLookup: lookup } : {}),
  };
}

test("reach posts to a Discord channel found through the Discord lookup", async () => {
  const seen: SurfaceContextQuery[] = [];
  const dir = directory(async (query) => {
    seen.push(query);
    return { messages: [], channel: { channelId: "1300000000000000010", name: "ops" } };
  });
  const r = await resolveReachTarget(dir, { channel: "#ops" }, "ana@acme.com");
  assert.deepEqual(r, {
    ok: true,
    destination: {
      type: "discord",
      target: "1300000000000000010",
      audienceScopeId: "channel:1300000000000000010",
    },
    channel: { channelId: "1300000000000000010", name: "ops" },
  });
  assert.deepEqual(seen, [{ lookupChannel: "#ops", postable: true, viewer: "ana@acme.com" }]);
});

test("a Slack directory hit never consults Discord", async () => {
  let calls = 0;
  const dir = directory(async () => {
    calls += 1;
    return null;
  });
  const r = await resolveReachTarget(dir, { channel: "eng" }, "ana@acme.com");
  assert.equal(r.ok && r.destination.type, "slack");
  assert.equal(calls, 0);
});

test("a Discord refusal is reported to the agent and nothing is routed", async () => {
  const dir = directory(async (): Promise<SurfaceContextResult> => ({ messages: [], note: "guest reader in #ops" }));
  const r = await resolveReachTarget(dir, { channel: "ops" }, "ana@acme.com");
  assert.deepEqual(r, {
    ok: false,
    status: 403,
    error: "discord_channel_unavailable",
    message: "guest reader in #ops",
  });
});

test("an unknown channel with no Discord match stays channel_not_found", async () => {
  for (const lookup of [async () => ({ messages: [] }), async () => null, undefined]) {
    const r = await resolveReachTarget(directory(lookup), { channel: "nowhere" }, "ana@acme.com");
    assert.equal(r.ok === false && r.error, "channel_not_found");
  }
});

test("an unconfirmed Discord lookup is a retry error for reads and stays channel_not_found for posts", async () => {
  const dir = directory(async () => ({ messages: [], retry: true }));
  const read = await resolveReachTarget(dir, { channel: "ops" }, "ana@acme.com", { forRead: true });
  assert.equal(read.ok === false && read.error, "discord_channel_unavailable");
  const post = await resolveReachTarget(dir, { channel: "ops" }, "ana@acme.com");
  assert.equal(post.ok === false && post.error, "channel_not_found");
});

function lookupHarness(opts: {
  channels: Array<{ id: string; name: string }>;
  views: Set<string>;
  verdict: { ok: true } | { ok: false; retry: boolean; reason: string };
}) {
  const outcomes: unknown[] = [];
  const guarded: string[] = [];
  const lookup = createChannelLookup({
    core: {
      fulfillContextRequest: async (_id, outcome) => void outcomes.push(outcome),
      discordUserIdsFor: () => ["111"],
    },
    reader: {
      find: async (q) => opts.channels.filter((c) => c.id === q || c.name === q.replace(/^#/, "")),
      canView: async (channelId, userId) => opts.views.has(`${channelId}:${userId}`),
    },
    guard: {
      mayPost: async (id) => {
        guarded.push(id);
        return opts.verdict;
      },
    },
  });
  const ask = (query: SurfaceContextQuery) =>
    lookup({ id: "q", source: "discord", createdAt: 0, status: "pending", query } satisfies SurfaceContextRequest);
  return { ask, outcomes, guarded };
}

const OPS = { id: "1300000000000000010", name: "ops" };

test("lookup resolves a visible, postable channel", async () => {
  const h = lookupHarness({ channels: [OPS], views: new Set([`${OPS.id}:111`]), verdict: { ok: true } });
  await h.ask({ lookupChannel: "ops", postable: true, viewer: "ana@acme.com" });
  assert.deepEqual(h.outcomes, [{ result: { messages: [], channel: { channelId: OPS.id, name: "ops" } } }]);
  assert.deepEqual(h.guarded, [OPS.id]);
});

test("lookup answers a channel the requester cannot view exactly like no match, before the reader gate", async () => {
  const h = lookupHarness({ channels: [OPS], views: new Set(), verdict: { ok: true } });
  await h.ask({ lookupChannel: "ops", postable: true, viewer: "ana@acme.com" });
  await h.ask({ lookupChannel: "nothing", postable: true, viewer: "ana@acme.com" });
  assert.deepEqual(h.outcomes, [{ result: { messages: [] } }, { result: { messages: [] } }]);
  assert.deepEqual(h.guarded, []);
});

test("lookup carries a retry flag, and no channel or wording that confirms existence, while members are still loading", async () => {
  const outcomes: unknown[] = [];
  const lookup = createChannelLookup({
    core: {
      fulfillContextRequest: async (_id, outcome) => void outcomes.push(outcome),
      discordUserIdsFor: () => ["111"],
    },
    reader: { find: async () => [OPS], canView: async () => undefined },
    guard: { mayPost: async () => ({ ok: true }) },
  });
  await lookup({
    id: "q",
    source: "discord",
    createdAt: 0,
    status: "pending",
    query: { lookupChannel: "ops", viewer: "ana@acme.com" },
  });
  assert.deepEqual(outcomes, [{ result: { messages: [], retry: true } }]);
});

test("lookup refuses to post where a guest can read", async () => {
  const h = lookupHarness({
    channels: [OPS],
    views: new Set([`${OPS.id}:111`]),
    verdict: { ok: false, retry: false, reason: "guest reader" },
  });
  await h.ask({ lookupChannel: "ops", postable: true, viewer: "ana@acme.com" });
  assert.deepEqual(h.outcomes, [{ error: "I can't post in #ops: guest reader." }]);
});

test("lookup asks to retry while readers are unknown", async () => {
  const h = lookupHarness({
    channels: [OPS],
    views: new Set([`${OPS.id}:111`]),
    verdict: { ok: false, retry: true, reason: "members_not_ready" },
  });
  await h.ask({ lookupChannel: "ops", postable: true, viewer: "ana@acme.com" });
  assert.deepEqual(h.outcomes, [
    { error: "I can't confirm who can read that Discord channel right now. Try again in a minute." },
  ]);
});

test("lookup without postable skips the reader gate", async () => {
  const h = lookupHarness({
    channels: [OPS],
    views: new Set([`${OPS.id}:111`]),
    verdict: { ok: false, retry: false, reason: "guest reader" },
  });
  await h.ask({ lookupChannel: OPS.id, viewer: "ana@acme.com" });
  assert.deepEqual(h.outcomes, [{ result: { messages: [], channel: { channelId: OPS.id, name: "ops" } } }]);
  assert.deepEqual(h.guarded, []);
});

test("lookup reports ambiguity only among channels the requester can view", async () => {
  const other = { id: "1300000000000000011", name: "ops" };
  const hidden = { id: "1300000000000000012", name: "ops" };
  const h = lookupHarness({
    channels: [OPS, other, hidden],
    views: new Set([`${OPS.id}:111`, `${other.id}:111`]),
    verdict: { ok: true },
  });
  await h.ask({ lookupChannel: "ops", viewer: "ana@acme.com" });
  const single = lookupHarness({
    channels: [OPS, hidden],
    views: new Set([`${OPS.id}:111`]),
    verdict: { ok: true },
  });
  await single.ask({ lookupChannel: "ops", viewer: "ana@acme.com" });
  assert.deepEqual(h.outcomes, [
    {
      error: `"ops" matches several Discord channels — pass an id: #ops (1300000000000000010), #ops (1300000000000000011)`,
    },
  ]);
  assert.deepEqual(single.outcomes, [{ result: { messages: [], channel: { channelId: OPS.id, name: "ops" } } }]);
});

test("the history reader finds configured-guild channels and threads by name or id", async () => {
  const text = (id: string, name: string, guildId: string) => ({ id, name, guildId, isTextBased: () => true });
  const channels = new Map<string, unknown>([
    ["1", text("1", "Ops", "g1")],
    ["2", text("2", "ops", "g-other")],
    ["3", { id: "3", name: "ops", guildId: "g1", isTextBased: () => false }],
    ["4", { id: "4", isTextBased: () => true, recipientId: "9" }],
    ["5", text("5", "random", "g1")],
  ]);
  const reader = createDiscordHistoryReader({
    channels: noLinkChannels({ channels: { cache: channels } } as never),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.deepEqual(await reader.find("#ops"), [{ id: "1", name: "Ops" }]);
  assert.deepEqual(await reader.find("5"), [{ id: "5", name: "random" }]);
  assert.deepEqual(await reader.find("missing"), []);
});

test("a channel lookup finds a DM by exact id only for its recipient", async () => {
  const DM = "1300000000000000040";
  const dm = { id: DM, type: ChannelType.DM, recipientId: "111", isTextBased: () => true };
  const reader = createDiscordHistoryReader({
    channels: noLinkChannels({ channels: { cache: new Map([[DM, dm]]), fetch: async () => dm } } as never),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  const lookup = (who: string) => {
    const outcomes: unknown[] = [];
    const ask = createChannelLookup({
      core: { fulfillContextRequest: async (_id, o) => void outcomes.push(o), discordUserIdsFor: () => [who] },
      reader,
      guard: { mayPost: async () => ({ ok: true }) },
    });
    return ask({
      id: "q",
      source: "discord",
      createdAt: 0,
      status: "pending",
      query: { lookupChannel: DM, viewer: "ana@acme.com" },
    }).then(() => outcomes);
  };
  assert.deepEqual(await lookup("111"), [
    { result: { messages: [], channel: { channelId: DM, name: "direct message", dm: true } } },
  ]);
  assert.deepEqual(await lookup("222"), [{ result: { messages: [] } }]);
});

test("the history reader prefers the exact id over channels merely named like it", async () => {
  const text = (id: string, name: string) => ({ id, name, guildId: "g1", isTextBased: () => true });
  const channels = new Map<string, unknown>([
    ["6", text("6", "decoy")],
    ["decoy", text("decoy", "6")],
    ["7", text("7", "6")],
  ]);
  const reader = createDiscordHistoryReader({
    channels: noLinkChannels({ channels: { cache: channels } } as never),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  assert.deepEqual(await reader.find("6"), [{ id: "6", name: "decoy" }]);
});

function triggerDeps(lookup?: ReachDirectory["discordLookup"]): TriggerDeps {
  return {
    directory: {
      channelMember: async () => true,
      groupMember: async () => true,
      get: async () => null,
      ...(lookup ? { discordLookup: lookup } : {}),
    },
  } as never;
}

test("a Discord destination is visible to the cron owner only when the owner can view it", async () => {
  const asked: SurfaceContextQuery[] = [];
  const dest = {
    type: "discord",
    target: "1300000000000000010:55",
    audienceScopeId: "channel:1300000000000000010",
  } as never;
  const sees = triggerDeps(async (q) => {
    asked.push(q);
    return { messages: [], channel: { channelId: "1300000000000000010", name: "ops" } };
  });
  assert.equal(await destinationVisible(sees, "ana@acme.com", dest), true);
  assert.deepEqual(asked, [{ lookupChannel: "1300000000000000010", viewer: "ana@acme.com" }]);
  assert.equal(
    await destinationVisible(
      triggerDeps(async () => ({ messages: [], note: "no" })),
      "ana@acme.com",
      dest,
    ),
    false,
  );
  assert.equal(
    await destinationVisible(
      triggerDeps(async () => null),
      "ana@acme.com",
      dest,
    ),
    false,
  );
  assert.equal(await destinationVisible(triggerDeps(), "ana@acme.com", dest), false);
  assert.equal(await destinationVisible({} as never, "ana@acme.com", dest), false);
});

test("a Discord DM destination is visible only to its owner, and only when the lookup confirms that DM channel", async () => {
  const asked: SurfaceContextQuery[] = [];
  const deps = (channelId: string) =>
    triggerDeps(async (q) => {
      asked.push(q);
      return { messages: [], channel: { channelId, name: "direct message", dm: true } };
    });
  const dm = { type: "discord", target: "4000:55", audienceScopeId: "personal:ana@acme.com" } as never;
  assert.equal(await destinationVisible(deps("4000"), "ana@acme.com", dm), true);
  assert.deepEqual(asked, [{ lookupChannel: "4000", viewer: "ana@acme.com" }]);
  assert.equal(await destinationVisible(deps("1300000000000000010"), "ana@acme.com", dm), false);
  assert.equal(await destinationVisible(deps("4000"), "bob@acme.com", dm), false);
  assert.equal(asked.length, 2);
});

test("a personal Discord audience never passes for a guild channel the owner can view", async () => {
  const CHAN = "1300000000000000010";
  const guildChannel = triggerDeps(async () => ({ messages: [], channel: { channelId: CHAN, name: "ops" } }));
  const personal = { type: "discord", target: CHAN, audienceScopeId: "personal:ana@acme.com" } as never;
  assert.equal(await destinationVisible(guildChannel, "ana@acme.com", personal), false);
});

test("a Discord destination is visible only when the lookup returns that exact channel id", async () => {
  const dest = {
    type: "discord",
    target: "1300000000000000010",
    audienceScopeId: "channel:1300000000000000010",
  } as never;
  const decoy = triggerDeps(async () => ({ messages: [], channel: { channelId: "1300000000000000099", name: "x" } }));
  assert.equal(await destinationVisible(decoy, "ana@acme.com", dest), false);
});

test("a prompt cron homed in a Discord channel runs when its owner can view the channel and skips when not", async () => {
  const CHAN = "1300000000000000010";
  const run = async (visible: boolean) => {
    let ran = false;
    const out = await runTrigger(
      {
        deliveries: createDeliveryStore(),
        idempotency: createIdempotencyStore(testMap()),
        identity: createIdentityService(testMap(), { externalMembers: testMap() }),
        run: async () => {
          ran = true;
          return { status: "ok", reply: "done" };
        },
        directory: {
          channelMember: async () => false,
          groupMember: async () => false,
          get: async () => null,
          channelPrivacy: async () => undefined,
          discordLookup: async () => (visible ? { messages: [], channel: { channelId: CHAN, name: "ops" } } : null),
        },
        sessions: { participantScopes: async () => [] },
      } as never,
      {
        owner: "ana@acme.com",
        ownerScopeId: scopeId("channel", CHAN),
        input: "check",
        fireKey: `cron:discord:${visible}`,
        surface: "cron",
        destination: { type: "discord", target: CHAN, audienceScopeId: scopeId("channel", CHAN) },
      },
    );
    return { ran, out };
  };
  assert.equal((await run(true)).ran, true);
  const denied = await run(false);
  assert.equal(denied.ran, false);
  assert.equal(denied.out.authzFailed, false);
});

const HOME_CHAN = "1300000000000000010";
const HOME_THREAD = "1300000000000000077";

function homedTrigger(
  lookup: ReachDirectory["discordLookup"],
  opts: { message?: string; fireKey: string; mayDeferReaders?: boolean },
) {
  const ran: string[] = [];
  const idempotency = createIdempotencyStore(testMap());
  const deps = {
    deliveries: createDeliveryStore(),
    idempotency,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async () => {
      ran.push("run");
      return { status: "ok", reply: "done" };
    },
    directory: {
      channelMember: async () => false,
      groupMember: async () => false,
      get: async () => null,
      channelPrivacy: async () => undefined,
      discordLookup: lookup,
    },
    sessions: { participantScopes: async () => [] },
  } as never;
  const fire = (fireKey = opts.fireKey) =>
    runTrigger(deps, {
      owner: "ana@acme.com",
      ownerScopeId: scopeId("channel", HOME_CHAN),
      input: "check",
      fireKey,
      surface: "cron",
      ...(opts.message !== undefined ? { message: opts.message } : {}),
      ...(opts.mayDeferReaders ? { mayDeferReaders: true } : {}),
      destination: { type: "discord", target: HOME_THREAD, audienceScopeId: scopeId("channel", HOME_CHAN) },
    });
  return { fire, ran };
}

test("a Discord-homed trigger with no destination checks the owner's Discord access, not past participation", async () => {
  const run = async (lookup: NonNullable<ReachDirectory["discordLookup"]>) => {
    const ran: string[] = [];
    const out = await runTrigger(
      {
        deliveries: createDeliveryStore(),
        idempotency: createIdempotencyStore(testMap()),
        identity: createIdentityService(testMap(), { externalMembers: testMap() }),
        run: async () => {
          ran.push("run");
          return { status: "ok", reply: "done" };
        },
        directory: {
          channelMember: async () => false,
          groupMember: async () => false,
          get: async () => null,
          channelPrivacy: async () => undefined,
          discordLookup: lookup,
        },
        sessions: { participantScopes: async () => [{ scopeId: scopeId("channel", HOME_CHAN) }] },
      } as never,
      {
        owner: "ana@acme.com",
        ownerScopeId: scopeId("channel", HOME_CHAN),
        input: "stage",
        fireKey: "loop:s1",
        surface: "loop",
      },
    );
    return { ran, out };
  };
  const hidden = await run(async () => ({ messages: [] }));
  assert.deepEqual(hidden.ran, []);
  assert.match(hidden.out.note ?? "", /no longer a member/);
  assert.deepEqual((await run(seesOnly(HOME_CHAN))).ran, ["run"]);
});

const seesOnly =
  (...visible: string[]): NonNullable<ReachDirectory["discordLookup"]> =>
  async (q) =>
    visible.includes(q.lookupChannel!)
      ? { messages: [], channel: { channelId: q.lookupChannel!, name: "ops" } }
      : { messages: [] };

test("a cron homed in a Discord thread runs only when the owner can see both the parent and the thread", async () => {
  const asked: string[] = [];
  const visible = seesOnly(HOME_CHAN, HOME_THREAD);
  const h = homedTrigger(
    async (q) => {
      asked.push(q.lookupChannel!);
      return visible(q);
    },
    { fireKey: "cron:thread-home" },
  );
  await h.fire();
  assert.deepEqual(h.ran, ["run"]);
  assert.deepEqual(asked, [HOME_CHAN, HOME_THREAD]);
});

test("a cron homed in a private Discord thread skips once the owner can no longer see the thread", async () => {
  const h = homedTrigger(seesOnly(HOME_CHAN), { fireKey: "cron:thread-removed" });
  const out = await h.fire();
  assert.deepEqual(h.ran, []);
  assert.equal(out.deferred, undefined);
  assert.match(out.note ?? "", /no longer a member/);
});

test("a message cron homed in a Discord thread the owner cannot see enqueues nothing", async () => {
  const h = homedTrigger(seesOnly(HOME_CHAN), { fireKey: "cron:thread-removed-msg", message: "ping" });
  await h.fire();
  assert.deepEqual(h.ran, []);
});

test("a Discord-homed trigger past the lateness bound skips instead of waiting for channel readers", async () => {
  const h = homedTrigger(async () => ({ messages: [], retry: true }), { fireKey: "cron:late-hydrating" });
  const out = await h.fire();
  assert.equal(out.deferred, undefined);
  assert.deepEqual(h.ran, []);
  assert.match(out.note ?? "", /did not load in time/);
});

test("a non-home Discord destination still runs the turn while channel readers are unknown", async () => {
  const deliveries = createDeliveryStore();
  const ran: string[] = [];
  const out = await runTrigger(
    {
      deliveries,
      idempotency: createIdempotencyStore(testMap()),
      identity: createIdentityService(testMap(), { externalMembers: testMap() }),
      run: async () => {
        ran.push("run");
        return { status: "ok", reply: "done" };
      },
      directory: {
        channelMember: async () => false,
        groupMember: async () => false,
        get: async () => null,
        channelPrivacy: async () => undefined,
        discordLookup: async () => ({ messages: [], retry: true }),
      },
      sessions: { participantScopes: async () => [] },
    } as never,
    {
      owner: "ana@acme.com",
      ownerScopeId: scopeId("personal", "ana@acme.com"),
      input: "check",
      fireKey: "cron:other-dest",
      surface: "cron",
      mayDeferReaders: true,
      destination: { type: "discord", target: HOME_THREAD, audienceScopeId: scopeId("channel", HOME_CHAN) },
    },
  );
  assert.deepEqual(ran, ["run"]);
  assert.equal(out.ran, true);
  assert.equal(out.deferred, undefined);
  assert.deepEqual(await deliveries.pending("discord"), []);
});

function triggerRunDeps(lookup: NonNullable<ReachDirectory["discordLookup"]>) {
  const deliveries = createDeliveryStore();
  const ran: string[] = [];
  const deps = {
    deliveries,
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async () => {
      ran.push("run");
      return { status: "ok", reply: "done" };
    },
    directory: {
      channelMember: async () => false,
      groupMember: async () => false,
      get: async () => null,
      channelPrivacy: async () => undefined,
      discordLookup: lookup,
    },
    sessions: { participantScopes: async () => [] },
  } as never;
  return { deps, deliveries, ran };
}

test("a personal home with a personal Discord audience still needs the owner's DM, not a guild channel they can view", async () => {
  const { deps, deliveries } = triggerRunDeps(seesOnly(HOME_CHAN));
  const out = await runTrigger(deps, {
    owner: "ana@acme.com",
    ownerScopeId: scopeId("personal", "ana@acme.com"),
    input: "check",
    message: "ping",
    fireKey: "cron:personal-guild",
    surface: "cron",
    destination: { type: "discord", target: HOME_CHAN, audienceScopeId: scopeId("personal", "ana@acme.com") },
  });
  assert.equal(out.status, "refused");
  assert.match(out.note ?? "", /no longer visible/);
  assert.deepEqual(await deliveries.pending("discord"), []);
});

test("a definitely invisible non-home destination wins over unknown home readers", async () => {
  const OTHER = "1300000000000000055";
  const lookup: NonNullable<ReachDirectory["discordLookup"]> = async (q) =>
    q.lookupChannel === HOME_CHAN ? { messages: [], retry: true } : { messages: [] };
  const fire = (destination: string) =>
    runTrigger(triggerRunDeps(lookup).deps, {
      owner: "ana@acme.com",
      ownerScopeId: scopeId("channel", HOME_CHAN),
      input: "check",
      fireKey: `cron:invisible-${destination}`,
      surface: "cron",
      destination: { type: "discord", target: destination, audienceScopeId: scopeId("channel", destination) },
    });
  const invisible = await fire(OTHER);
  assert.equal(invisible.status, "refused");
  assert.equal(invisible.readersUnknown, undefined);
  assert.equal((await fire(HOME_CHAN)).readersUnknown, true);
});

function homeMessageDeps(lookup: NonNullable<ReachDirectory["discordLookup"]>, roster?: Array<Record<string, string>>) {
  const deliveries = createDeliveryStore();
  const deps = {
    deliveries,
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async () => ({ status: "ok", reply: "done" }),
    directory: {
      channelMember: async () => true,
      groupMember: async () => false,
      get: async () => null,
      channelPrivacy: async () => true,
      conversationMembers: async () => roster,
      discordLookup: lookup,
    },
    sessions: { participantScopes: async () => [] },
  } as never;
  return { deps, deliveries };
}

test("a roster-confirmed owner's message cron delivers to its private Discord channel home without a lookup", async () => {
  const lookups: string[] = [];
  const { deps, deliveries } = homeMessageDeps(
    async (q) => {
      lookups.push(q.lookupChannel ?? "");
      return { messages: [], retry: true };
    },
    [{ principalId: "ana@acme.com", displayName: "Ana", type: "internal" }],
  );
  const out = await runTrigger(deps, {
    owner: "ana@acme.com",
    ownerScopeId: scopeId("channel", HOME_CHAN),
    input: "x",
    message: "ping",
    fireKey: "cron:roster-home",
    surface: "cron",
    mayDeferReaders: true,
    destination: { type: "discord", target: HOME_CHAN, audienceScopeId: scopeId("channel", HOME_CHAN) },
  });
  assert.equal(out.status, "ok");
  assert.equal((await deliveries.pending("discord")).length, 1);
  assert.deepEqual(lookups, []);
});

test("a conversation-owned cron keeps delivering to its Discord channel home", async () => {
  const home = scopeId("channel", HOME_CHAN);
  const { deps, deliveries } = homeMessageDeps(async () => ({ messages: [] }));
  const out = await runTrigger(deps, {
    owner: scopeActor(home),
    ownerScopeId: home,
    input: "x",
    message: "ping",
    fireKey: "cron:scope-home",
    surface: "cron",
    destination: { type: "discord", target: HOME_CHAN, audienceScopeId: home },
  });
  assert.equal(out.status, "ok");
  assert.equal((await deliveries.pending("discord")).length, 1);
});

test("a personal Discord home whose DM lookup times out defers, or reports unknown readers when it cannot defer", async () => {
  const fire = (mayDeferReaders: boolean) => {
    const { deps, deliveries } = homeMessageDeps(async () => ({ messages: [], retry: true }));
    return runTrigger(deps, {
      owner: "ana@acme.com",
      ownerScopeId: scopeId("personal", "ana@acme.com"),
      input: "x",
      message: "ping",
      fireKey: `cron:personal-retry-${mayDeferReaders}`,
      surface: "cron",
      mayDeferReaders,
      destination: { type: "discord", target: HOME_CHAN, audienceScopeId: scopeId("personal", "ana@acme.com") },
    }).then(async (out) => ({ out, pending: (await deliveries.pending("discord")).length }));
  };
  const deferred = await fire(true);
  assert.equal(deferred.out.deferred, true);
  assert.equal(deferred.out.ran, false);
  const unknown = await fire(false);
  assert.equal(unknown.out.status, "refused");
  assert.equal(unknown.out.readersUnknown, true);
  assert.equal(unknown.pending, 0);
});

function gatewayLookup(opts: {
  thread: { type: ChannelType; members: string[] } | null;
  threadMemberError?: { code?: number; status?: number };
}): { lookup: NonNullable<ReachDirectory["discordLookup"]>; fetched: string[] } {
  const fetched: string[] = [];
  const member = { id: "111" };
  const guild = { id: "g1", members: { cache: new Map([["111", member]]) } };
  const perms = { has: (p: unknown) => p !== PermissionFlagsBits.ManageThreads };
  const parent = {
    id: HOME_CHAN,
    name: "ops",
    guildId: "g1",
    guild,
    type: ChannelType.GuildText,
    isThread: () => false,
    isTextBased: () => true,
    permissionsFor: () => perms,
  };
  const cache = new Map<string, unknown>([[HOME_CHAN, parent]]);
  const thread = opts.thread && {
    id: HOME_THREAD,
    name: "deploy",
    guildId: "g1",
    guild,
    parent,
    type: opts.thread.type,
    isThread: () => true,
    isTextBased: () => true,
    members: {
      cache: new Map(),
      fetch: async ({ member: who }: { member: string }) => {
        if (opts.thread!.members.includes(who)) return {};
        throw Object.assign(new Error("Unknown Member"), opts.threadMemberError ?? { code: 10007, status: 404 });
      },
    },
  };
  const reader = createDiscordHistoryReader({
    channels: noLinkChannels({
      channels: {
        cache,
        fetch: async (id: string) => {
          const hit = cache.get(id);
          if (hit) return hit;
          fetched.push(id);
          if (id !== HOME_THREAD || !thread) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
          cache.set(id, thread);
          return thread;
        },
      },
    } as never),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  const outcomes: Array<{ result?: SurfaceContextResult }> = [];
  const ask = createChannelLookup({
    core: {
      fulfillContextRequest: async (_id, outcome) => void outcomes.push(outcome as never),
      discordUserIdsFor: () => ["111"],
    },
    reader,
    guard: { mayPost: async () => ({ ok: true }) },
  });
  return {
    fetched,
    lookup: async (query) => {
      await ask({ id: "q", source: "discord", createdAt: 0, status: "pending", query } satisfies SurfaceContextRequest);
      return outcomes.at(-1)?.result ?? null;
    },
  };
}

test("a cron homed in an archived, uncached public Discord thread fires once the thread is fetched", async () => {
  const g = gatewayLookup({ thread: { type: ChannelType.PublicThread, members: [] } });
  const h = homedTrigger(g.lookup, { fireKey: "cron:archived-public" });
  await h.fire();
  assert.deepEqual(h.ran, ["run"]);
  assert.deepEqual(g.fetched, [HOME_THREAD]);
});

test("a cron homed in an archived private Discord thread fires only while the owner is a thread member", async () => {
  const member = homedTrigger(gatewayLookup({ thread: { type: ChannelType.PrivateThread, members: ["111"] } }).lookup, {
    fireKey: "cron:archived-private-member",
  });
  await member.fire();
  assert.deepEqual(member.ran, ["run"]);
  const removed = homedTrigger(gatewayLookup({ thread: { type: ChannelType.PrivateThread, members: [] } }).lookup, {
    fireKey: "cron:archived-private-removed",
  });
  await removed.fire();
  assert.deepEqual(removed.ran, []);
});

test("a deleted Discord thread is not visible, and a transient fetch failure retries instead", async () => {
  const gone = homedTrigger(gatewayLookup({ thread: null }).lookup, { fireKey: "cron:thread-gone" });
  const goneOut = await gone.fire();
  assert.deepEqual(gone.ran, []);
  assert.equal(goneOut.deferred, undefined);
  assert.match(goneOut.note ?? "", /no longer a member/);
  const flaky = homedTrigger(
    gatewayLookup({ thread: { type: ChannelType.PrivateThread, members: [] }, threadMemberError: { status: 500 } })
      .lookup,
    { fireKey: "cron:thread-flaky", mayDeferReaders: true },
  );
  const flakyOut = await flaky.fire();
  assert.equal(flakyOut.deferred, true);
  assert.deepEqual(flaky.ran, []);
});

test("a Discord-homed trigger that cannot see its home skips after a single lookup", async () => {
  const asked: string[] = [];
  const h = homedTrigger(
    async (q) => {
      asked.push(q.lookupChannel!);
      return { messages: [] };
    },
    { fireKey: "cron:hidden-home", message: "ping" },
  );
  const out = await h.fire();
  assert.equal(out.deferred, undefined);
  assert.deepEqual(asked, [HOME_CHAN]);
});

test("a Discord-homed trigger defers, without claiming its fire key, while channel readers are unknown", async () => {
  let loaded = false;
  const h = homedTrigger(async (q) => (loaded ? seesOnly(HOME_CHAN, HOME_THREAD)(q) : { messages: [], retry: true }), {
    fireKey: "cron:hydrating",
    message: "ping",
    mayDeferReaders: true,
  });
  const first = await h.fire();
  assert.equal(first.deferred, true);
  assert.equal(first.ran, false);
  assert.equal(first.authzFailed, false);
  loaded = true;
  const second = await h.fire();
  assert.equal(second.ran, true);
  assert.equal(second.deferred, undefined);
});

test("a one-shot cron homed in Discord stays enabled when it fires while channel readers are unknown", async () => {
  const CHAN = "1300000000000000010";
  const built = buildApp(testConfig());
  await installDiscord(built);
  await built.app.upsertDirectory([{ principalId: "ana@acme.com", displayName: "Ana", type: "internal" }]);
  const seen: SurfaceContextQuery[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      for (const r of await built.app.pendingContextRequests("discord")) {
        seen.push(r.query);
        await built.app.fulfillContextRequest(r.id, { result: { messages: [], retry: true } });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const cron = await built.crons.create({
    owner: "ana@acme.com",
    ownerScopeId: scopeId("channel", CHAN),
    createdBy: "ana@acme.com",
    schedule: { firstFireAt: Date.now() + 60_000 },
    action: "ping",
    message: "ping",
    destination: { type: "discord", target: CHAN, audienceScopeId: scopeId("channel", CHAN) },
  });
  await built.scheduler.tick(Date.now() + 60_000);
  polling = false;
  await poller;
  assert.deepEqual(seen, [{ lookupChannel: CHAN, viewer: "ana@acme.com" }]);
  assert.equal((await built.crons.get(cron.id))?.enabled, true);
});

test("a one-shot cron homed in Discord stays enabled when the Discord lookup times out", async () => {
  const CHAN = "1300000000000000011";
  const built = buildApp(testConfig());
  await installDiscord(built);
  await built.app.upsertDirectory([{ principalId: "ana@acme.com", displayName: "Ana", type: "internal" }]);
  let asked = 0;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      for (const r of await built.app.pendingContextRequests("discord")) {
        asked += 1;
        await built.app.deleteContextRequest(r.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const cron = await built.crons.create({
    owner: "ana@acme.com",
    ownerScopeId: scopeId("channel", CHAN),
    createdBy: "ana@acme.com",
    schedule: { firstFireAt: Date.now() + 60_000 },
    action: "ping",
    message: "ping",
    destination: { type: "discord", target: CHAN, audienceScopeId: scopeId("channel", CHAN) },
  });
  await built.scheduler.tick(Date.now() + 60_000);
  polling = false;
  await poller;
  assert.equal(asked, 1);
  assert.equal((await built.crons.get(cron.id))?.enabled, true);
});

test("a cron homed in Discord gives up an unanswered channel lookup after the short trigger wait", async () => {
  const CHAN = "1300000000000000012";
  const built = buildApp(testConfig());
  await installDiscord(built);
  await built.app.upsertDirectory([{ principalId: "ana@acme.com", displayName: "Ana", type: "internal" }]);
  let asked = 0;
  let polling = true;
  const poller = (async () => {
    const seenIds = new Set<string>();
    while (polling) {
      for (const r of await built.app.pendingContextRequests("discord")) {
        if (!seenIds.has(r.id)) asked += 1;
        seenIds.add(r.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  await built.crons.create({
    owner: "ana@acme.com",
    ownerScopeId: scopeId("channel", CHAN),
    createdBy: "ana@acme.com",
    schedule: { firstFireAt: Date.now() + 60_000 },
    action: "ping",
    message: "ping",
    destination: { type: "discord", target: CHAN, audienceScopeId: scopeId("channel", CHAN) },
  });
  const started = Date.now();
  await built.scheduler.tick(Date.now() + 60_000);
  const elapsed = Date.now() - started;
  polling = false;
  await poller;
  assert.equal(asked, 1);
  assert.ok(elapsed < 10_000, `trigger lookup waited ${elapsed} ms`);
});

test("an inactive Discord surface never gets a channel lookup", async () => {
  const built = buildApp(testConfig());
  const seen: SurfaceContextQuery[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      for (const r of await built.app.pendingContextRequests("discord")) {
        seen.push(r.query);
        await built.app.fulfillContextRequest(r.id, { result: { messages: [] } });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const r = await built.app.resolveReachTarget({ channel: "ops" }, "ana@acme.com");
  polling = false;
  await poller;
  assert.equal(r.ok === false && r.error, "channel_not_found");
  assert.deepEqual(seen, []);
});

describe("POST /v1/reach into a Discord channel", () => {
  const SECRET = "discord-reach-secret".repeat(3);
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let answer: SurfaceContextResult | { error: string };
  const asked: SurfaceContextQuery[] = [];
  let stopPolling = false;

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    await installDiscord(built);
    await built.app.upsertDirectory([{ principalId: "U-carol", displayName: "Carol", type: "internal" }]);
    server = createServer(built.app, {
      signingSecret: SECRET,
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    void (async () => {
      while (!stopPolling) {
        for (const r of await built.app.pendingContextRequests("discord")) {
          asked.push(r.query);
          await built.app.fulfillContextRequest(r.id, "error" in answer ? answer : { result: answer });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
  });

  after(async () => {
    stopPolling = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = async (body: unknown) =>
    fetch(`${base}/v1/reach`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await mintCapabilityToken(
          { actorId: "U-carol", scopeId: scopeId("personal", "U-carol"), exp: Date.now() + CAPABILITY_TTL_MS },
          SECRET,
        ),
      },
      body: JSON.stringify(body),
    });

  it("enqueues a discord delivery for the resolved channel", async () => {
    answer = { messages: [], channel: { channelId: OPS.id, name: "ops" } };
    const res = await post({ channel: "#ops", text: "deploy done" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliveryId: string; channel: unknown };
    assert.deepEqual(body.channel, { channelId: OPS.id, name: "ops" });
    const d = (await built.app.pendingDeliveries("discord")).find((x) => x.id === body.deliveryId);
    assert.equal(d?.destination.target, OPS.id);
    assert.equal(d?.text, "deploy done");
    assert.deepEqual(asked.at(-1), { lookupChannel: "#ops", postable: true, viewer: "U-carol" });
  });

  it("enqueues nothing when Discord refuses the channel", async () => {
    answer = { error: "I can't post in #ops: guest reader." };
    const before = (await built.app.pendingDeliveries("discord")).length;
    const res = await post({ channel: "ops", text: "secret" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "discord_channel_unavailable");
    assert.equal((await built.app.pendingDeliveries("discord")).length, before);
  });

  it("scheduling a post into a refused Discord channel reports discord_channel_unavailable, not not_a_member", async () => {
    answer = { error: "I can't post in #ops: guest reader." };
    const control = createControlService(built.app, built.scheduler, built.admin);
    const dm = { type: "web", target: "t", audienceScopeId: scopeId("personal", "U-carol") };
    const r = await control.createCron(
      { schedule: { everyMs: 3_600_000 }, action: "post", channel: "ops" },
      {
        actorId: "U-carol",
        scopeId: scopeId("personal", "U-carol"),
        destination: dm,
        destinations: [{ ...dm, key: "k", label: "dm" }],
        defaultDestinationKey: "k",
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
    );
    assert.equal(r.ok ? "" : r.code, "discord_channel_unavailable");
  });
});
