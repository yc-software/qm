import { linkedDiscordUserIds } from "../src/api/discord-core-client.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { EventEmitter } from "node:events";
import { ChannelType, Events, GatewayIntentBits, MessageType, Partials, PermissionFlagsBits } from "discord.js";
import { resolveTurnOrigin } from "../src/core/turn-origin.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";
import { scopeId, type Principal } from "../src/types.ts";
import { DISCORD_CLIENT_OPTIONS } from "../src/discord/client.ts";
import { createDiscordPlugin, DISCORD_DELIVERY_POLL_MS } from "../src/discord/index.ts";
import { DISCORD_RETRY_BASE_MS } from "../src/discord/config.ts";
import { ACK_REACTION_DELAY_MS } from "../src/surfaces/ack-presenter.ts";
import { DISCORD_DIRECTORY_SYNC_MS } from "../src/discord/directory.ts";
import type { DiscordPluginConfig } from "../src/discord/config.ts";
import type { DiscordCoreClient } from "../src/api/discord-core-client.ts";

const cfg: DiscordPluginConfig = {
  botToken: "fake-token",
  guildIds: new Set(),
  internalRoleIds: new Set(),
};

function fakeClient({ emitReady = false, ...over }: { emitReady?: boolean } & Record<string, unknown> = {}) {
  const client = new EventEmitter();
  return Object.assign(client, {
    user: { id: "999", tag: "bot#1", username: "qm" },
    login: async () => {
      if (emitReady)
        queueMicrotask(() => {
          client.emit("shardReady", 0);
          client.emit("clientReady", client);
        });
      return "ok";
    },
    destroy: async () => {},
    channels: { cache: new Map(), fetch: async () => null },
    guilds: { cache: new Map(), fetch: async () => null },
    ...over,
  });
}

function fakeCore(): DiscordCoreClient {
  return {
    submitTurn: async () => ({ status: "queued", runId: "r1" }),
    waitRun: async () => ({ status: "ok", reply: "done" }),
    streamSnapshot: () => null,
    linkedInternal: async (id: string) => id === "111",
    coreStatus: async () => ({ notInternal: false }),
    discordUserIdsFor: linkedDiscordUserIds,
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => {},
    linkPrivateThread: async () => {},
  } as unknown as DiscordCoreClient;
}

test("stop drains in-flight handle before calling client.destroy", async () => {
  const events: string[] = [];
  let inFlightResolve: () => void;
  const inFlightPromise = new Promise<void>((r) => {
    inFlightResolve = r;
  });

  const client = fakeClient({
    destroy: async () => {
      events.push("client.destroy");
    },
  });

  const slowCore = {
    ...fakeCore(),
    submitTurn: async () => {
      events.push("handle.start");
      await inFlightPromise;
      events.push("handle.finish");
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory: () => client as never,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  };

  client.emit("messageCreate", fakeMessage);

  await new Promise((r) => setTimeout(r, 10));

  const stopPromise = plugin.stop();

  client.emit("messageCreate", {
    ...fakeMessage,
    id: "m2",
    content: "hello 2",
  });

  await new Promise((r) => setTimeout(r, 20));
  inFlightResolve!();
  await stopPromise;

  assert.deepEqual(events, ["handle.start", "handle.finish", "client.destroy"]);
});

test("plugin is restartable and creates a new client on each start", async () => {
  let clientCount = 0;
  const destroyed: number[] = [];

  const factory = () => {
    const id = ++clientCount;
    return fakeClient({
      destroy: async () => {
        destroyed.push(id);
      },
    }) as never;
  };

  const plugin = createDiscordPlugin(cfg, fakeCore(), { clientFactory: factory, drainTimeoutMs: 5000 });
  await plugin.start();
  assert.equal(clientCount, 1);
  await plugin.stop();
  assert.deepEqual(destroyed, [1]);

  await plugin.start();
  assert.equal(clientCount, 2);
  await plugin.stop();
  assert.deepEqual(destroyed, [1, 2]);
});

test("start during stop drain immediately creates a new client that survives the old drain", async () => {
  const events: string[] = [];
  let finishSlowMessage: () => void;
  const slowMessagePromise = new Promise<void>((r) => {
    finishSlowMessage = r;
  });

  const createdClients: Array<{ id: number; emitter: EventEmitter; destroyed: boolean; loggedIn: boolean }> = [];
  let clientSeq = 0;

  const clientFactory = () => {
    const id = ++clientSeq;
    const emitter = fakeClient({
      user: { id: `bot-${id}`, tag: `bot#000${id}` },
      login: async () => {
        clientRecord.loggedIn = true;
        events.push(`login:${id}`);
        return "ok";
      },
      destroy: async () => {
        clientRecord.destroyed = true;
        events.push(`destroy:${id}`);
      },
    });
    const clientRecord = {
      id,
      emitter,
      destroyed: false,
      loggedIn: false,
    };
    createdClients.push(clientRecord);
    return emitter as never;
  };

  const slowCore = {
    ...fakeCore(),
    submitTurn: async () => {
      events.push("turn:start");
      await slowMessagePromise;
      events.push("turn:finish");
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory,
    drainTimeoutMs: 5000,
  });

  await plugin.start();
  assert.equal(createdClients.length, 1);
  assert.equal(createdClients[0]!.loggedIn, true);

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  };

  createdClients[0]!.emitter.emit("messageCreate", fakeMessage);
  await new Promise((r) => setTimeout(r, 10));

  const stopPromise = plugin.stop();
  const startPromise = plugin.start();

  await new Promise((r) => setTimeout(r, 20));
  finishSlowMessage!();
  await Promise.all([stopPromise, startPromise]);

  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[1]!.loggedIn, true);
  assert.equal(createdClients[1]!.destroyed, false);
  assert.equal(createdClients[0]!.destroyed, true);
});

test("a second stop while draining waits for the same drain", async () => {
  const events: string[] = [];
  let finishSlowMessage: () => void;
  const slowMessagePromise = new Promise<void>((r) => {
    finishSlowMessage = r;
  });

  const client = fakeClient({
    destroy: async () => {
      events.push("client.destroy");
    },
  });

  const slowCore = {
    ...fakeCore(),
    submitTurn: async () => {
      events.push("handle.start");
      await slowMessagePromise;
      events.push("handle.finish");
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, slowCore, {
    clientFactory: () => client as never,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  };

  client.emit("messageCreate", fakeMessage);
  await new Promise((r) => setTimeout(r, 10));

  let secondStopResolved = false;
  const firstStop = plugin.stop();
  const secondStop = plugin.stop().then(() => {
    secondStopResolved = true;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondStopResolved, false);
  assert.equal(events.includes("client.destroy"), false);

  finishSlowMessage!();
  await Promise.all([firstStop, secondStop]);

  assert.equal(secondStopResolved, true);
  assert.deepEqual(events, ["handle.start", "handle.finish", "client.destroy"]);
});

test("second stop does not settle before second client drain even if previous destroy rejects", async () => {
  let finishTurn1: () => void;
  const turn1Promise = new Promise<void>((r) => {
    finishTurn1 = r;
  });
  let finishTurn2: () => void;
  const turn2Promise = new Promise<void>((r) => {
    finishTurn2 = r;
  });

  let clientSeq = 0;
  const emitters: EventEmitter[] = [];
  const factory = () => {
    const id = ++clientSeq;
    const client = fakeClient({
      user: { id: `bot-${id}`, tag: `bot#000${id}` },
      destroy: async () => {
        if (id === 1) {
          throw new Error("first client destroy failed");
        }
      },
    });
    emitters.push(client);
    return client as never;
  };

  const core = {
    ...fakeCore(),
    submitTurn: async (req: { text: string }) => {
      if (req.text === "turn 1") await turn1Promise;
      if (req.text === "turn 2") await turn2Promise;
      return { status: "ok", reply: "done" };
    },
  } as unknown as DiscordCoreClient;

  const plugin = createDiscordPlugin(cfg, core, {
    clientFactory: factory,
    drainTimeoutMs: 5000,
  });

  await plugin.start();

  const fakeMessage = (text: string) => ({
    id: `m-${text}`,
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: text,
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({
        edit: async () => {},
        delete: async () => {},
      }),
    },
  });

  emitters[0]!.emit("messageCreate", fakeMessage("turn 1"));
  await new Promise((r) => setTimeout(r, 10));

  const stop1 = plugin.stop();
  stop1.catch(() => {});
  const start2 = plugin.start();
  await start2;

  emitters[1]!.emit("messageCreate", fakeMessage("turn 2"));
  await new Promise((r) => setTimeout(r, 10));

  let secondStopSettled = false;
  const stop2 = plugin.stop();
  stop2
    .catch(() => {})
    .finally(() => {
      secondStopSettled = true;
    });

  finishTurn1!();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(secondStopSettled, false);

  finishTurn2!();
  await assert.rejects(stop2, /first client destroy failed/);
  assert.equal(secondStopSettled, true);
});

test("a failed login retries with a new client", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const createdClients: Array<{ id: number; destroyed: boolean; loggedIn: boolean }> = [];
    let clientSeq = 0;

    const factory = () => {
      const id = ++clientSeq;
      const record = { id, destroyed: false, loggedIn: false };
      createdClients.push(record);
      return fakeClient({
        user: { id: `bot-${id}`, tag: `bot#000${id}` },
        login: async () => {
          if (id === 1) {
            throw new Error("login failed");
          }
          record.loggedIn = true;
          return "ok";
        },
        destroy: async () => {
          record.destroyed = true;
        },
      }) as never;
    };

    const plugin = createDiscordPlugin(cfg, fakeCore(), { clientFactory: factory, drainTimeoutMs: 5000 });
    await plugin.start();

    assert.equal(createdClients.length, 1);
    assert.equal(createdClients[0]!.destroyed, true);
    assert.equal(createdClients[0]!.loggedIn, false);

    mock.timers.tick(DISCORD_RETRY_BASE_MS);
    await Promise.resolve();

    assert.equal(createdClients.length, 2);
    assert.equal(createdClients[0]!.destroyed, true);
    assert.equal(createdClients[1]!.destroyed, false);
    assert.equal(createdClients[1]!.loggedIn, true);

    await plugin.stop();
  } finally {
    mock.timers.reset();
  }
});

test("stop cancels a pending login retry so a restart connects at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const createdClients: Array<{ id: number; destroyed: boolean; loggedIn: boolean }> = [];
    let clientSeq = 0;

    const factory = () => {
      const id = ++clientSeq;
      const record = { id, destroyed: false, loggedIn: false };
      createdClients.push(record);
      return fakeClient({
        user: { id: `bot-${id}`, tag: `bot#000${id}` },
        login: async () => {
          throw new Error("login failed");
        },
        destroy: async () => {
          record.destroyed = true;
        },
      }) as never;
    };

    const plugin = createDiscordPlugin(cfg, fakeCore(), { clientFactory: factory, drainTimeoutMs: 5000 });
    await plugin.start();

    assert.equal(createdClients.length, 1);
    await plugin.stop();
    await plugin.start();
    assert.equal(createdClients.length, 2);
    await plugin.stop();

    mock.timers.tick(DISCORD_RETRY_BASE_MS * 2);
    await Promise.resolve();

    assert.equal(createdClients.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("c1 login rejection after stop and start does not schedule a retry or create a new client", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let clientSeq = 0;
    let rejectLogin1: (err: Error) => void;
    const login1Promise = new Promise<string>((_, reject) => {
      rejectLogin1 = reject;
    });

    const factory = () => {
      const id = ++clientSeq;
      return fakeClient({
        user: { id: `bot-${id}`, tag: `bot#000${id}` },
        login: async () => {
          if (id === 1) return await login1Promise;
          return "ok";
        },
      }) as never;
    };

    const plugin = createDiscordPlugin(cfg, fakeCore(), {
      clientFactory: factory,
      drainTimeoutMs: 5000,
    });

    const start1 = plugin.start();
    await Promise.resolve();
    assert.equal(clientSeq, 1);

    await plugin.stop();

    const start2 = plugin.start();
    await start2;
    assert.equal(clientSeq, 2);

    const setTimeoutSpy = mock.method(globalThis, "setTimeout");
    rejectLogin1!(new Error("c1 login failed"));
    await start1.catch(() => {});
    for (let i = 0; i < 10; i++) await Promise.resolve();

    assert.equal(setTimeoutSpy.mock.calls.length, 0);

    mock.timers.tick(DISCORD_RETRY_BASE_MS * 2);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    assert.equal(clientSeq, 2);

    await plugin.stop();
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

interface HistoryRow {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean; globalName: string | null };
}

const historyRow = (r: HistoryRow) => ({
  ...r,
  mentions: { users: new Map() },
  attachments: new Map(),
  reactions: { cache: new Map() },
});
const historyMap = (rows: HistoryRow[] = []) => new Map(rows.map((r) => [r.id, historyRow(r)]));

function guildHarness(opts: {
  authorRoles: string[];
  viewers: Array<{ id: string; roles: string[]; bot?: boolean }>;
  hydrationFails?: boolean;
  submitResult?: (b: Record<string, unknown>) => Promise<Record<string, unknown>>;
  extraGuild?: { id: string; members: Array<{ id: string; roles: string[] }> };
  parentHistory?: HistoryRow[];
  threadHistory?: HistoryRow[];
  threadOwnerId?: string;
  threadStarter?: HistoryRow;
  threadHistoryFails?: boolean;
  internalUserIds?: string[];
  watermarks?: Array<{ container: string; lastTs: string }>;
  backfillRows?: Array<Record<string, unknown>>;
  threadMessages?: Map<string, unknown>;
  threadLastMessageId?: string;
  directoryGate?: () => Promise<void> | undefined;
  probeGate?: Promise<void>;
  activeThreads?: Array<{ id: string; type: ChannelType; parentId: string }>;
  linkRefuses?: string[];
}) {
  const gapNotes: Array<{ channelId: string; note: string }> = [];
  const threadDeletes: string[] = [];
  const submitted: Array<Record<string, unknown>> = [];
  const links: Array<{ threadId: string; parentId: string; submittedBefore: number }> = [];
  const ingested: unknown[][] = [];
  let historyFetchCount = 0;
  let memberFetches = 0;
  const fetchCalls: Array<{ channel: string; limit?: number; before?: string; after?: string }> = [];
  const reactions: string[] = [];
  const messageStub = {
    react: async (e: string) => void reactions.push(`+${e}`),
    reactions: { resolve: (e: string) => ({ users: { remove: async () => void reactions.push(`-${e}`) } }) },
  };
  const threads: string[] = [];
  const channelPosts: string[] = [];
  const threadPosts: string[] = [];
  const acked: string[] = [];
  const pendingRows: Array<Record<string, unknown>> = [];
  const directoryPushes: unknown[][] = [];
  let enqueued: () => void = () => {};
  const member = (id: string, roles: string[], bot = false) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    guild: { id: "900" },
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
  });
  const cache = new Map(opts.viewers.map((v) => [v.id, member(v.id, v.roles, v.bot)]));
  const guild = {
    id: "900",
    members: {
      cache,
      fetch: async () => {
        memberFetches += 1;
        if (opts.hydrationFails) throw new Error("gateway timeout");
        return cache;
      },
    },
    roles: { cache: new Map() },
    channels: {
      fetchActiveThreads: async () => ({ threads: new Map((opts.activeThreads ?? []).map((t) => [t.id, t])) }),
    },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    isTextBased: () => true,
    send: async () => ({ id: "p1" }),
    permissionsFor: () => ({ has: () => true }),
    isDMBased: () => false,
    lastMessageId: null,
    messages: {
      fetch: async (o: { limit?: number; before?: string; after?: string } | string) => {
        if (typeof o === "string") return messageStub;
        fetchCalls.push({ channel: "c1", ...o });
        if (opts.backfillRows && o.limit === 100 && !o.before)
          return new Map(opts.backfillRows.map((m) => [m.id as string, m]));
        historyFetchCount += 1;
        return historyMap(opts.parentHistory);
      },
    },
  };
  const thread = {
    id: "t1",
    parentId: "c1",
    parent,
    guild,
    name: "deploy it",
    ownerId: opts.threadOwnerId ?? "999",
    delete: async () => void threadDeletes.push("t1"),
    fetchStarterMessage: async () => {
      if (!opts.threadStarter) throw new Error("no starter");
      return historyRow(opts.threadStarter);
    },
    isThread: () => true,
    isTextBased: () => true,
    isDMBased: () => false,
    lastMessageId: opts.threadLastMessageId ?? null,
    send: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      threadPosts.push(text);
      return { id: "s1", edit: async () => {}, delete: async () => {} };
    },
    sendTyping: async () => {},
    messages: {
      fetch: async (o: { limit?: number; before?: string; after?: string } | string) => {
        if (typeof o === "string") return messageStub;
        fetchCalls.push({ channel: "t1", ...o });
        if (o.limit === 2) {
          await opts.probeGate;
          return opts.threadMessages ?? new Map();
        }
        if (opts.backfillRows && o.limit === 100 && !o.before)
          return new Map(opts.backfillRows.map((m) => [m.id as string, m]));
        historyFetchCount += 1;
        if (opts.threadHistoryFails && o.before) throw new Error("missing access");
        return historyMap(opts.threadHistory);
      },
    },
  };
  const channelsCache = new Map<string, unknown>([
    ["c1", parent],
    ["t1", thread],
  ]);
  const extraGuildCache = opts.extraGuild
    ? new Map(opts.extraGuild.members.map((m) => [m.id, member(m.id, m.roles)]))
    : null;
  const extraGuild = opts.extraGuild
    ? {
        id: opts.extraGuild.id,
        members: { cache: extraGuildCache, fetch: async () => extraGuildCache },
        roles: { cache: new Map() },
      }
    : null;
  const emitter = fakeClient({
    emitReady: true,
    channels: {
      cache: channelsCache,
      fetch: async (id: string) => (id === "c1" ? parent : thread),
    },
    guilds: {
      cache: new Map(
        extraGuild
          ? [
              ["900", guild],
              [extraGuild.id, extraGuild],
            ]
          : [["900", guild]],
      ),
      fetch: async (id: string) => {
        if (id === "900") return guild;
        return extraGuild && id === extraGuild.id ? extraGuild : null;
      },
    },
  });
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      if (opts.submitResult) return await opts.submitResult(b);
      return { status: "silent" };
    },
    linkPrivateThread: async (threadId: string, parentId: string) => {
      if (opts.linkRefuses?.includes(threadId)) throw new Error(`thread ${threadId} has its own config`);
      links.push({ threadId, parentId, submittedBefore: submitted.length });
    },
    linkedInternal: async (id: string) => (opts.internalUserIds ?? []).includes(id),
    coreStatus: async () => ({ notInternal: false }),
    ingestSurfaceEvents: async (events: unknown[]) => {
      ingested.push(events);
    },
    onDeliveryEnqueued: (listener: () => void) => {
      enqueued = listener;
      return () => {};
    },
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    channelWatermarks: async () => opts.watermarks ?? [],
    noteSurfaceHistoryGap: async (channelId: string, note: string) => void gapNotes.push({ channelId, note }),
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    holdDirectorySync: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    syncDirectory: async (members: unknown[]) => {
      await opts.directoryGate?.();
      directoryPushes.push(members);
    },
    claimDeliveries: async (type: string) => (type === "discord" ? pendingRows.splice(0) : []),
    ackDelivery: async (id: string) => void acked.push(id),
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const message = {
    id: "1300000000000000001",
    channelId: "c1",
    guildId: "900",
    guild,
    author: { id: "111", username: "ana", bot: false, globalName: null },
    member: member("111", opts.authorRoles),
    content: "<@999> deploy it",
    mentions: { users: new Map([["999", {}]]) },
    attachments: new Map(),
    channel: {
      ...parent,
      name: "eng",
      send: async (o: { content?: string } | string) => {
        const text = typeof o === "string" ? o : (o.content ?? "");
        channelPosts.push(text);
        return { id: "r1" };
      },
    },
    reply: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      channelPosts.push(text);
      return { id: "r1" };
    },
    startThread: async () => {
      threads.push("t1");
      return thread;
    },
  };
  const plugin = createDiscordPlugin(
    {
      botToken: "t",
      guildIds: new Set(extraGuild ? ["900", extraGuild.id] : ["900"]),
      internalRoleIds: new Set(["staff"]),
    },
    core,
    {
      clientFactory: () => emitter as never,
      drainTimeoutMs: 1000,
    },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    plugin,
    emitter,
    message,
    thread,
    submitted,
    threads,
    channelPosts,
    threadPosts,
    settle,
    acked,
    pendingRows,
    directoryPushes,
    enqueue: () => enqueued(),
    ingested,
    historyFetchCount: () => historyFetchCount,
    memberFetches: () => memberFetches,
    fetchCalls,
    reactions,
    gapNotes,
    threadDeletes,
    links,
    core,
  };
}

test("once members are hydrated the guild's internal humans are pushed to the directory with avatars", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "222", roles: [] },
      { id: "333", roles: ["staff"], bot: true },
    ],
  });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.directoryPushes, [
    [{ principalId: "discord:111", displayName: "u111", type: "internal", avatarUrl: "https://cdn.example/111.png" }],
  ]);
});

test("stopping the plugin waits for an in-flight periodic directory push", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let pushes = 0;
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    directoryGate: () => (++pushes > 1 ? gate : undefined),
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  await h.plugin.start();
  await h.settle();
  assert.equal(pushes, 1);
  t.mock.timers.tick(DISCORD_DIRECTORY_SYNC_MS);
  await h.settle();
  assert.equal(pushes, 2);
  let stopped = false;
  const stopping = h.plugin.stop().then(() => (stopped = true));
  await h.settle();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(h.directoryPushes.length, 2);
});

test("a failed hydration pushes nothing to the directory", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }], hydrationFails: true });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.directoryPushes, []);
});

test("a staff mention in a private channel opens a thread and submits a channel turn with its audience", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "112", roles: ["staff"] },
    ],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.threads, ["t1"]);
  const body = h.submitted[0]! as { conversation: Record<string, unknown>; deliveryTarget: string };
  assert.equal(body.conversation.kind, "channel");
  assert.equal(body.conversation.threadRef, "discord:th:t1");
  assert.equal(body.deliveryTarget, "t1");
  assert.deepEqual(
    (body.conversation.audience as Array<{ externalId: string }>).map((a) => a.externalId),
    ["discord:111", "discord:112"],
  );
});

test("a private thread is linked to its parent when it is created, before any turn in it", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit(Events.ThreadCreate, { id: "t2", type: ChannelType.PrivateThread, parentId: "c1", guildId: "900" });
  h.emitter.emit(Events.ThreadCreate, { id: "t3", type: ChannelType.PublicThread, parentId: "c1", guildId: "900" });
  h.emitter.emit(Events.ThreadCreate, { id: "t4", type: ChannelType.PrivateThread, parentId: "c9", guildId: "901" });
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.links, [{ threadId: "t2", parentId: "c1", submittedBefore: 0 }]);
  assert.equal(h.submitted.length, 0);
});

test("on ready every active private thread in a configured guild is linked to its parent", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    activeThreads: [
      { id: "t5", type: ChannelType.PrivateThread, parentId: "c1" },
      { id: "t6", type: ChannelType.PublicThread, parentId: "c1" },
    ],
  });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.links, [{ threadId: "t5", parentId: "c1", submittedBefore: 0 }]);
});

test("a refused private thread link does not stop the startup scan from linking later threads", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    linkRefuses: ["t5"],
    activeThreads: [
      { id: "t5", type: ChannelType.PrivateThread, parentId: "c1" },
      { id: "t7", type: ChannelType.PrivateThread, parentId: "c1" },
    ],
  });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.links, [{ threadId: "t7", parentId: "c1", submittedBefore: 0 }]);
});

test("a private thread is its own scope whose audience is its members, and its scope is not entitled from the parent or a public sibling thread", async () => {
  const viewers = [
    { id: "111", roles: ["staff"] },
    { id: "112", roles: ["staff"] },
    { id: "113", roles: ["staff"] },
  ];
  const links: Array<Array<{ threadId: string; parentId: string; submittedBefore: number }>> = [];
  const turnIn = async (threadType: ChannelType | null) => {
    const h = guildHarness({ authorRoles: ["staff"], viewers });
    Object.assign(h.thread, {
      type: threadType ?? ChannelType.PublicThread,
      members: { fetch: async () => new Map([["111", {}]]) },
    });
    Object.assign(h.thread.parent, {
      name: "eng",
      permissionsFor: () => ({ has: (p: unknown) => p !== PermissionFlagsBits.ManageThreads }),
    });
    await h.plugin.start();
    await h.settle();
    h.emitter.emit(
      "messageCreate",
      threadType === null ? h.message : inThread(h, { id: "1300000000000000009", content: "<@999> status?" }),
    );
    await h.settle();
    await h.plugin.stop();
    links.push(h.links);
    return (
      h.submitted[0] as {
        conversation: {
          kind: "channel";
          channelRef: string;
          channelName?: string;
          audience: Array<{ externalId: string }>;
        };
      }
    ).conversation;
  };
  const priv = await turnIn(ChannelType.PrivateThread);
  const pub = await turnIn(ChannelType.PublicThread);
  const parent = await turnIn(null);
  assert.equal(priv.channelRef, "t1");
  assert.equal("parentChannelRef" in priv, false);
  assert.deepEqual(
    links.map((l) => [...new Set(l.map((x) => JSON.stringify(x)))]),
    [[JSON.stringify({ threadId: "t1", parentId: "c1", submittedBefore: 0 })], [], []],
  );
  assert.equal(priv.channelName, "deploy it");
  assert.equal(pub.channelName, "eng");
  assert.deepEqual(
    priv.audience.map((a) => a.externalId),
    ["discord:111"],
  );
  assert.equal(pub.channelRef, "c1");
  assert.equal(parent.channelRef, "c1");
  assert.deepEqual(
    parent.audience.map((a) => a.externalId),
    ["discord:111", "discord:112", "discord:113"],
  );
  const reader = { id: "p-113", type: "internal" } as Principal;
  const org = scopeId("org", "o1");
  const privateLabel = scopeId("channel", "t1");
  assert.equal(principalEntitledToScope(reader, privateLabel, scopeId("channel", pub.channelRef), org), false);
  assert.equal(principalEntitledToScope(reader, privateLabel, scopeId("channel", parent.channelRef), org), false);
});

test("guild turns use mode spine and never post model output directly to the channel", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: async () => ({ status: "ok", reply: "secret model reply" }),
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(h.threadPosts, []);
  assert.deepEqual(h.channelPosts, []);
});

test("a guild whose member list contains the bot never lists the bot as a reader", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "999", roles: [], bot: true },
    ],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  const audience = (h.submitted[0] as { conversation: { audience: Array<{ externalId: string }> } }).conversation
    .audience;
  assert.deepEqual(
    audience.map((a) => a.externalId),
    ["discord:111"],
  );
});

test("a reader who is internal via another configured guild counts as internal", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "222", roles: [] },
    ],
    extraGuild: { id: "901", members: [{ id: "222", roles: ["staff"] }] },
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  const audience = (
    h.submitted[0] as { conversation: { audience: Array<{ externalId: string; isExternalGuest?: boolean }> } }
  ).conversation.audience;
  const reader = audience.find((a) => a.externalId === "discord:222");
  assert.equal(reader?.isExternalGuest, undefined);
});

test("a mention from a guest is ignored: no thread, no turn", async () => {
  const h = guildHarness({ authorRoles: [], viewers: [{ id: "111", roles: [] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.threads, []);
  assert.deepEqual(h.submitted, []);
});

test("a staff mention in a channel a guest can read still submits, and core refuses it", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "555", roles: [] },
    ],
    submitResult: async () => ({
      status: "refused",
      reason: "internal-only: shared audience includes a non-internal participant",
    }),
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  const audience = (
    h.submitted[0] as { conversation: { audience: Array<{ externalId: string; isExternalGuest?: boolean }> } }
  ).conversation.audience;
  assert.ok(audience.some((a) => a.externalId === "discord:555" && a.isExternalGuest));
  assert.deepEqual(h.threadPosts, [
    "I can't answer here: people outside the organization can read this channel. Ask me in a private channel or a DM.",
  ]);
});

test("while members are not hydrated, a staff mention is refused with a clear message and nothing is submitted", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }], hydrationFails: true });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.threads, []);
  assert.deepEqual(h.channelPosts, [
    "I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.",
  ]);
});

test("after ShardReconnecting readers are unknown until the session resumes", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("shardReconnecting", 0);
  h.pendingRows.push({
    id: "d1",
    text: "cron result",
    idempotencyKey: "cron:x",
    createdAt: 0,
    deliveredAt: null,
    destination: { type: "discord", target: "t1" },
  });
  h.enqueue();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.channelPosts, [
    "I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.",
  ]);
  assert.deepEqual(h.acked, []);
  h.emitter.emit("shardResume", 0, 0);
  await h.settle();
  h.emitter.emit("messageCreate", { ...h.message, id: "m2" });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
});

test("the dispatcher also drains on the DISCORD_DELIVERY_POLL_MS timer, not only on enqueue", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await h.plugin.start();
    await h.settle();
    h.pendingRows.push({
      id: "d1",
      text: "cron result",
      idempotencyKey: "cron:x",
      createdAt: 0,
      deliveredAt: null,
      destination: { type: "discord", target: "t1" },
    });
    assert.deepEqual(h.acked, []);
    mock.timers.tick(DISCORD_DELIVERY_POLL_MS);
    await h.settle();
    await h.plugin.stop();
    assert.deepEqual(h.acked, ["d1"]);
  } finally {
    mock.timers.reset();
  }
});

test("a guildId-null message from a group DM channel submits no turn", async () => {
  const submitted: unknown[] = [];
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      return { status: "queued", runId: "r1" };
    },
  } as unknown as DiscordCoreClient;
  const client = fakeClient();
  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => client as never, drainTimeoutMs: 5000 });
  await plugin.start();
  const groupDmMessage = {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: {
      type: ChannelType.GroupDM,
      isThread: () => false,
      send: async () => ({ edit: async () => {}, delete: async () => {} }),
    },
  };
  client.emit("messageCreate", groupDmMessage);
  await new Promise((r) => setTimeout(r, 10));
  await plugin.stop();
  assert.deepEqual(submitted, []);
});

test("a message in an unconfigured guild triggers no ingest and no history fetch", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    guildId: "777",
    content: "deploy it",
  });
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.ingested, []);
  assert.equal(h.historyFetchCount(), 0);
});

test("a mention in a configured guild is mirrored into the surface cache", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 1);
});

test("a staked unprompted follow-up in a thread submits a turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  assert.deepEqual(h.threads, ["t1"]);
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m2",
    channelId: "t1",
    content: "no mention here",
    mentions: { users: new Map() },
    channel: h.thread,
    reply: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      h.threadPosts.push(text);
      return { id: "r2" };
    },
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 2);
});

test("a human mention and a human staked follow-up in a guild thread resolve to human and live ambient origins", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m2",
    channelId: "t1",
    content: "no mention here",
    mentions: { users: new Map() },
    channel: h.thread,
    reply: async () => ({ id: "r2" }),
  });
  await h.settle();
  await h.plugin.stop();
  const origins = h.submitted.map((b) => resolveTurnOrigin(b as never));
  assert.equal(origins[0]!.kind, "human");
  assert.deepEqual(origins[1], { kind: "ambient", entryTs: "m2", live: true });
});

test("an explicit mention in a thread the bot never marked does not fetch stake history", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    channelId: "t1",
    content: "<@999> still here",
    channel: h.thread,
    reply: async (o: { content?: string } | string) => {
      const text = typeof o === "string" ? o : (o.content ?? "");
      h.threadPosts.push(text);
      return { id: "r2" };
    },
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(
    h.fetchCalls.filter((c) => c.before === undefined),
    [],
  );
});

test("the bot's own message in a configured guild thread is mirrored with no history fetch", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m-self",
    channelId: "t1",
    author: { id: "999", username: "qm", bot: true, globalName: null },
    content: "here's the answer",
    mentions: { users: new Map() },
    channel: h.thread,
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 1);
  const event = (h.ingested[0] as Array<{ self: boolean }>)[0]!;
  assert.equal(event.self, true);
  assert.equal(h.historyFetchCount(), 0);
  assert.equal(h.submitted.length, 0);
});

test("another bot's message in a staked thread is mirrored and submits no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  assert.deepEqual(h.threads, ["t1"]);
  const fetchesBeforeSecondMessage = h.historyFetchCount();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m-other-bot",
    channelId: "t1",
    author: { id: "222", username: "otherbot", bot: true, globalName: null },
    content: "beep boop",
    mentions: { users: new Map() },
    channel: h.thread,
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 2);
  const event = (h.ingested[1] as Array<{ self: boolean; bot: boolean }>)[0]!;
  assert.equal(event.self, false);
  assert.equal(event.bot, true);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.historyFetchCount(), fetchesBeforeSecondMessage);
});

test("another bot's message in an unstaked thread is not mirrored", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "m-other-bot",
    channelId: "t1",
    author: { id: "222", username: "otherbot", bot: true, globalName: null },
    content: "beep boop",
    mentions: { users: new Map() },
    channel: h.thread,
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.ingested.length, 0);
  assert.equal(h.submitted.length, 0);
  assert.equal(h.historyFetchCount(), 1);
});

test("a member removed from the guild between hydrations is dropped from the cached member list", async () => {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    guild: { id: "900" },
  });
  const membersCache = new Map([
    ["111", member("111", ["staff"])],
    ["222", member("222", ["staff"])],
  ]);
  let kicked = false;
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => (kicked ? new Map([["111", membersCache.get("111")!]]) : new Map(membersCache)),
    },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const submitted: Array<Record<string, unknown>> = [];
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      return { status: "silent" };
    },
    linkedInternal: async () => false,
    coreStatus: async () => ({ notInternal: false }),
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const client = fakeClient({
    emitReady: true,
    channels: { cache: new Map([["c1", parent]]), fetch: async () => parent },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });
  const plugin = createDiscordPlugin(
    { botToken: "t", guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => client as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const mention = (id: string) => ({
    id,
    channelId: "c1",
    guildId: "900",
    guild,
    author: { id: "111", username: "u111", bot: false, globalName: null },
    member: member("111", ["staff"]),
    content: "<@999> hi",
    mentions: { users: new Map([["999", {}]]) },
    attachments: new Map(),
    channel: { ...parent, name: "eng", send: async () => ({ id: "r1" }) },
    reply: async () => ({ id: "r1" }),
    startThread: async () => ({
      id: "t1",
      parentId: "c1",
      parent,
      guild,
      isThread: () => true,
      send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
      sendTyping: async () => {},
    }),
  });
  await plugin.start();
  await settle();
  client.emit("messageCreate", mention("m1"));
  await settle();
  kicked = true;
  client.emit("shardResume", 0, 0);
  await settle();
  client.emit("messageCreate", mention("m2"));
  await settle();
  await plugin.stop();
  assert.equal(submitted.length, 2);
  const before = (submitted[0] as { conversation: { audience: Array<{ externalId: string }> } }).conversation.audience;
  const after = (submitted[1] as { conversation: { audience: Array<{ externalId: string }> } }).conversation.audience;
  assert.deepEqual(before.map((a) => a.externalId).sort(), ["discord:111", "discord:222"]);
  assert.deepEqual(after.map((a) => a.externalId).sort(), ["discord:111"]);
});

test("a member added to the cache while the fetch is pending is still cached afterwards and appears in readers", async () => {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    guild: { id: "900" },
  });
  const membersCache = new Map([["111", member("111", ["staff"])]]);
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => {
        membersCache.set("222", member("222", []));
        return new Map([["111", membersCache.get("111")!]]);
      },
    },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const submitted: Array<Record<string, unknown>> = [];
  const core = {
    ...fakeCore(),
    submitTurn: async (b: Record<string, unknown>) => {
      submitted.push(b);
      return { status: "silent" };
    },
    linkedInternal: async () => false,
    coreStatus: async () => ({ notInternal: false }),
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const client = fakeClient({
    emitReady: true,
    channels: { cache: new Map([["c1", parent]]), fetch: async () => parent },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });
  const plugin = createDiscordPlugin(
    { botToken: "t", guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => client as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const mention = {
    id: "m1",
    channelId: "c1",
    guildId: "900",
    guild,
    author: { id: "111", username: "u111", bot: false, globalName: null },
    member: member("111", ["staff"]),
    content: "<@999> hi",
    mentions: { users: new Map([["999", {}]]) },
    attachments: new Map(),
    channel: { ...parent, name: "eng", send: async () => ({ id: "r1" }) },
    reply: async () => ({ id: "r1" }),
    startThread: async () => ({
      id: "t1",
      parentId: "c1",
      parent,
      guild,
      isThread: () => true,
      send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
      sendTyping: async () => {},
    }),
  };
  await plugin.start();
  await settle();
  assert.equal(guild.members.cache.has("222"), true);
  client.emit("messageCreate", mention);
  await settle();
  await plugin.stop();
  assert.equal(submitted.length, 1);
  const audience = (submitted[0] as { conversation: { audience: Array<{ externalId: string }> } }).conversation
    .audience;
  assert.deepEqual(audience.map((a) => a.externalId).sort(), ["discord:111", "discord:222"]);
});

test("a rejected fetch prunes nothing", async () => {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    guild: { id: "900" },
  });
  const membersCache = new Map([["111", member("111", ["staff"])]]);
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => {
        throw new Error("gateway timeout");
      },
    },
  };
  const parent = { id: "c1", guild, isThread: () => false, permissionsFor: () => ({ has: () => true }) };
  const core = {
    ...fakeCore(),
    linkedInternal: async () => false,
    coreStatus: async () => ({ notInternal: false }),
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const client = fakeClient({
    emitReady: true,
    channels: { cache: new Map([["c1", parent]]), fetch: async () => parent },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });
  const plugin = createDiscordPlugin(
    { botToken: "t", guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => client as never, drainTimeoutMs: 1000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await plugin.start();
  await settle();
  await plugin.stop();
  assert.equal(membersCache.has("111"), true);
});

test("a run in flight from a stopping connection is not delivered by the next connection's dispatcher", async () => {
  const acked: string[] = [];
  const dmCfg: DiscordPluginConfig = {
    botToken: "t",
    guildIds: new Set(),
    internalRoleIds: new Set(),
  };
  let claimed = false;
  let messageSent = false;
  let resolveWaitRun!: () => void;
  const waitRunPromise = new Promise<{ status: "silent" }>((resolve) => {
    resolveWaitRun = () => resolve({ status: "silent" });
  });
  const core = {
    ...fakeCore(),
    submitTurn: async () => ({ status: "queued", runId: "r1" }),
    waitRun: () => waitRunPromise,
    reportRunEditRef: async () => {},
    linkedInternal: async (id: string) => id === "111",
    coreStatus: async () => ({ notInternal: false }),
    ingestSurfaceEvents: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    claimDeliveries: async (type: string) => {
      if (type !== "discord" || claimed || !messageSent) return [];
      claimed = true;
      return [
        {
          id: "d1",
          text: "cron result",
          idempotencyKey: "run:r1",
          createdAt: Date.now() - 1_000_000,
          deliveredAt: null,
          destination: { type: "discord", target: "c1" },
        },
      ];
    },
    ackDelivery: async (id: string) => void acked.push(id),
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  } as unknown as DiscordCoreClient;
  const dmChannel = {
    type: ChannelType.DM,
    recipientId: "111",
    isThread: () => false,
    isTextBased: () => true,
    send: async () => ({ id: "s1", edit: async () => {}, delete: async () => {} }),
    messages: { edit: async () => {}, delete: async () => {} },
  };
  const emitters: EventEmitter[] = [];
  const factory = () => {
    const client = fakeClient({
      emitReady: true,
      channels: { cache: new Map(), fetch: async () => dmChannel },
    });
    emitters.push(client);
    return client as never;
  };
  const plugin = createDiscordPlugin(dmCfg, core, { clientFactory: factory, drainTimeoutMs: 20 });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  await plugin.start();
  await settle();
  messageSent = true;
  emitters[0]!.emit("messageCreate", {
    id: "m1",
    channelId: "c1",
    guildId: null,
    author: { id: "111", username: "user", bot: false, globalName: null },
    content: "hello",
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: dmChannel,
  });
  await settle();

  await plugin.stop();
  await plugin.start();
  await settle();

  assert.deepEqual(acked, []);
  resolveWaitRun();
  await plugin.stop();
  await settle();
});

test("a ClientReady that fires after detach starts no delivery subscription or poll", async () => {
  let subscriptions = 0;
  const core = {
    ...fakeCore(),
    onDeliveryEnqueued: () => {
      subscriptions += 1;
      return () => {};
    },
  } as unknown as DiscordCoreClient;
  let fireReady: (() => void) | null = null;
  const client = fakeClient({
    login: async () => {
      fireReady = () => client.emit("clientReady", client);
      return "ok";
    },
  });
  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => client as never, drainTimeoutMs: 20 });
  await plugin.start();
  await plugin.stop();
  fireReady!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subscriptions, 0);
});

function continuationHarness(opts: { members: Array<{ id: string; roles: string[] }> }) {
  const member = (id: string, roles: string[]) => ({
    id,
    displayName: `u${id}`,
    user: { id, bot: false, globalName: null, username: `u${id}` },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    guild: { id: "900" },
  });
  const membersCache = new Map(opts.members.map((m) => [m.id, member(m.id, m.roles)]));
  const guild = {
    id: "900",
    members: {
      cache: membersCache,
      fetch: async () => membersCache,
    },
  };
  const parent = {
    id: "c1",
    guild,
    isThread: () => false,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const threadEdits: string[] = [];
  const statusMessage = {
    id: "s1",
    edit: async (content: string) => {
      threadEdits.push(content);
    },
    delete: async () => {},
  };
  const thread = {
    id: "t1",
    parentId: "c1",
    parent,
    guild,
    isThread: () => true,
    isTextBased: () => true,
    send: async () => statusMessage,
    sendTyping: async () => {},
    messages: {
      fetch: async () => statusMessage,
      edit: async () => statusMessage,
      delete: async () => {},
    },
  };
  const channelsMap = new Map<string, unknown>([
    ["c1", parent],
    ["t1", thread],
  ]);
  const DID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const core = {
    ...fakeCore(),
    getDelivery: async (id: string) =>
      id === DID
        ? {
            id: DID,
            destination: {
              type: "discord-dm",
              target: "discord:111",
              commandApprovalId: "A1",
            },
          }
        : null,
    getApproval: async (id: string) =>
      id === "A1"
        ? {
            requestId: "A1",
            command: "deploy",
            request: {
              surface: "discord",
              actor: { externalId: "discord:111" },
              conversation: { kind: "channel", threadRef: "discord:th:t1", channelRef: "c1" },
              deliveryTarget: "t1",
              text: "deploy",
            },
          }
        : null,
    submitTurn: async () => ({ status: "queued", runId: "r1" }),
    waitRun: async () => ({ status: "ok", reply: "deploying now" }),
    reportRunEditRef: async () => {},
    ackRunDelivery: async () => {},
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [],
    claimDeliveries: async () => [],
    ackDelivery: async () => {},
    reportDeliveryUndeliverable: async () => {},
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
  } as unknown as DiscordCoreClient;

  const client = fakeClient({
    emitReady: true,
    channels: {
      cache: channelsMap,
      fetch: async (id: string) => channelsMap.get(id) ?? null,
    },
    guilds: { cache: new Map([["900", guild]]), fetch: async () => guild },
  });

  const plugin = createDiscordPlugin(
    { botToken: "t", guildIds: new Set(["900"]), internalRoleIds: new Set(["staff"]) },
    core,
    { clientFactory: () => client as never, drainTimeoutMs: 1000 },
  );

  const settle = () => new Promise((r) => setTimeout(r, 40));
  const click = () => {
    client.emit(Events.InteractionCreate, {
      isButton: () => true,
      customId: `qm:cmd:once:${DID}`,
      user: { id: "111" },
      deferUpdate: async () => {},
      followUp: async () => {},
      editReply: async () => {},
    });
  };

  return { plugin, settle, click, threadEdits };
}

test("interaction button for guild-thread continuation enforces reader gate through plugin harness", async () => {
  const h = continuationHarness({
    members: [
      { id: "111", roles: ["staff"] },
      { id: "666", roles: [] },
    ],
  });
  await h.plugin.start();
  await h.settle();
  h.click();
  await h.settle();
  await h.plugin.stop();

  assert.equal(h.threadEdits.at(-1), "I can't post this reply here right now.");
  assert.ok(!h.threadEdits.includes("deploying now"));
});

test("interaction button for guild-thread continuation allows streaming when all readers are internal", async () => {
  const h = continuationHarness({
    members: [{ id: "111", roles: ["staff"] }],
  });
  await h.plugin.start();
  await h.settle();
  h.click();
  await h.settle();
  await h.plugin.stop();

  assert.equal(h.threadEdits.at(-1), "deploying now");
});

test("a lookupChannel context request goes to the channel lookup, not the conversation reader", async () => {
  const fulfilled: unknown[] = [];
  const core = {
    ...fakeCore(),
    onDeliveryEnqueued: () => () => {},
    discordUserIdsFor: () => ["u1"],
    onContextRequest: () => () => {},
    pendingContextRequests: async () => [
      { id: "cr-1", source: "discord", createdAt: 0, status: "pending", query: { lookupChannel: "ops", viewer: "v" } },
    ],
    fulfillContextRequest: async (_id: string, outcome: unknown) => void fulfilled.push(outcome),
  } as unknown as DiscordCoreClient;
  const client = fakeClient({ emitReady: true });
  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => client as never, drainTimeoutMs: 20 });
  await plugin.start();
  await new Promise((r) => setTimeout(r, 40));
  await plugin.stop();
  assert.deepEqual(fulfilled, [{ result: { messages: [] } }]);
});

test("context requests lifecycle wires to ClientReady and unsubscribes on stop", async () => {
  let contextSubscriptions = 0;
  let contextUnsubscribed = 0;
  let pendingDrained = 0;
  const fulfilled: Array<{ id: string; outcome: unknown }> = [];

  const pendingRequest = {
    id: "cr-pending-1",
    source: "discord",
    createdAt: 0,
    status: "pending",
    query: { conversationTarget: "dm1", viewer: "user@example.com" },
  };

  let listener: ((request: unknown) => void) | null = null;

  const core = {
    ...fakeCore(),
    onDeliveryEnqueued: () => () => {},
    discordUserIdsFor: () => ["u1"],
    onContextRequest: (fn: (request: unknown) => void) => {
      contextSubscriptions += 1;
      listener = fn;
      return () => {
        contextUnsubscribed += 1;
      };
    },
    pendingContextRequests: async () => {
      pendingDrained += 1;
      return [pendingRequest];
    },
    fulfillContextRequest: async (id: string, outcome: unknown) => {
      fulfilled.push({ id, outcome });
    },
  } as unknown as DiscordCoreClient;

  const dmChannel = {
    id: "dm1",
    type: ChannelType.DM,
    recipientId: "u1",
    isThread: () => false,
    isTextBased: () => true,
    messages: {
      fetch: async () =>
        new Map([
          [
            "1300000000000000001",
            {
              id: "1300000000000000001",
              content: "hello from dm",
              author: { id: "u1", globalName: null, username: "user" },
            },
          ],
        ]),
    },
  };
  const client = fakeClient({
    emitReady: true,
    channels: {
      cache: new Map([["dm1", dmChannel]]),
      fetch: async () => dmChannel,
    },
    guilds: {
      cache: new Map(),
      fetch: async () => ({ members: { cache: new Map(), fetch: async () => new Map() } }),
    },
  });

  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => client as never, drainTimeoutMs: 20 });
  await plugin.start();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(contextSubscriptions, 1);
  assert.equal(pendingDrained, 1);
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0]!.id, "cr-pending-1");

  listener!({
    id: "cr-live-1",
    source: "discord",
    createdAt: 0,
    status: "pending",
    query: { conversationTarget: "dm1", viewer: "user@example.com" },
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fulfilled.length, 2);
  assert.equal(fulfilled[1]!.id, "cr-live-1");

  await plugin.stop();
  assert.equal(contextUnsubscribed, 1);
});

test("the same context request delivered by drain and live event fulfills only once", async () => {
  const fulfilled: string[] = [];
  const duplicateRequest = {
    id: "cr-dup-1",
    source: "discord",
    createdAt: 0,
    status: "pending",
    query: { conversationTarget: "dm1", viewer: "user@example.com" },
  };

  let listener: ((request: unknown) => void) | null = null;
  const core = {
    ...fakeCore(),
    onDeliveryEnqueued: () => () => {},
    discordUserIdsFor: () => ["u1"],
    onContextRequest: (fn: (request: unknown) => void) => {
      listener = fn;
      return () => {};
    },
    pendingContextRequests: async () => [duplicateRequest],
    fulfillContextRequest: async (id: string) => {
      fulfilled.push(id);
    },
  } as unknown as DiscordCoreClient;

  const dmChannel = {
    id: "dm1",
    type: ChannelType.DM,
    recipientId: "u1",
    isThread: () => false,
    isTextBased: () => true,
    messages: {
      fetch: async () => new Map(),
    },
  };
  const client = fakeClient({
    channels: {
      cache: new Map([["dm1", dmChannel]]),
      fetch: async () => dmChannel,
    },
    guilds: {
      cache: new Map(),
      fetch: async () => ({ members: { cache: new Map(), fetch: async () => new Map() } }),
    },
    login: async () => {
      queueMicrotask(() => {
        client.emit(Events.ClientReady, client);
        listener?.(duplicateRequest);
      });
      return "ok";
    },
  });

  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => client as never, drainTimeoutMs: 20 });
  await plugin.start();
  await new Promise((r) => setTimeout(r, 50));
  await plugin.stop();

  assert.deepEqual(fulfilled, ["cr-dup-1"]);
});

test("a ClientReady that fires after detach starts no context subscription or drain", async () => {
  let subscriptions = 0;
  let drained = 0;
  const core = {
    ...fakeCore(),
    onDeliveryEnqueued: () => () => {},
    onContextRequest: () => {
      subscriptions += 1;
      return () => {};
    },
    pendingContextRequests: async () => {
      drained += 1;
      return [];
    },
  } as unknown as DiscordCoreClient;
  let fireReady: (() => void) | null = null;
  const client = fakeClient({
    login: async () => {
      fireReady = () => client.emit("clientReady", client);
      return "ok";
    },
  });
  const plugin = createDiscordPlugin(cfg, core, { clientFactory: () => client as never, drainTimeoutMs: 20 });
  await plugin.start();
  await plugin.stop();
  fireReady!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subscriptions, 0);
  assert.equal(drained, 0);
});

const ANA = { id: "111", username: "ana", bot: false, globalName: null };
const BO = { id: "222", username: "bo", bot: false, globalName: null };
const SELF = { id: "999", username: "qm", bot: true, globalName: null };
const REACTION_TARGET_TEXT =
  "Each message in the conversation above carries an id in brackets like `[~abc123]`. To react to one of those messages, pass that exact id, including the leading `~`, as the react action's `ts`.";
const DISCORD_DETECT_GUIDANCE =
  "Express the reaction as one Discord emoji short-name written WITH colons (e.g. `:pray:`), the one THIS persona would naturally reach for — common picks: `:pray:` (thanks), `:+1:` (got it), `:rocket:`/`:tada:` (a win), `:eyes:` (on it) — but choose whatever genuinely fits, not a fixed menu.";
const HANDOFF_TEXT = "When work needs another person's own logins, files or memory, follow the `hand-off` skill.";

function inThread(h: ReturnType<typeof guildHarness>, over: Record<string, unknown>) {
  return {
    ...h.message,
    channelId: "t1",
    channel: h.thread,
    reply: async () => ({ id: "r2" }),
    ...over,
  };
}

test("a thread turn carries prior turns, overheard lines, detect context, header and gateway context from thread history", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "112", roles: ["staff"] },
    ],
    threadHistory: [
      { id: "1300000000000000002", content: "Checking now", author: SELF },
      { id: "1300000000000000001", content: "can you check the deploy?", author: ANA },
      { id: "1300000000000000003", content: "also the <@!111> db", author: BO },
    ],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", inThread(h, { id: "1300000000000000009", content: "<@999> and now?" }));
  await h.settle();
  await h.plugin.stop();
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.deepEqual(body.priorTurns, [
    { role: "user", name: "ana", text: "[~9vkbjfeanyf5] can you check the deploy?" },
    { role: "assistant", text: "[~9vkbjfeanyf6] Checking now" },
    { role: "user", name: "bo", text: "[~9vkbjfeanyf7] also the @u111 db" },
  ]);
  assert.deepEqual(body.overheard, [
    { ts: "1300000000000000001", role: "user", name: "ana", text: "can you check the deploy?" },
    { ts: "1300000000000000002", role: "self", text: "Checking now" },
    { ts: "1300000000000000003", role: "user", name: "bo", text: "also the @u111 db" },
  ]);
  assert.equal(body.detectContext, "ana: can you check the deploy?\nbo: also the @u111 db");
  assert.equal(body.conversationHeader, "You are in a channel. You are replying in a thread you started.");
  assert.deepEqual(body.gatewayContext, {
    location: "channel c1",
    details: { channel: "c1", thread_id: "t1" },
    instructions: `${REACTION_TARGET_TEXT}\n\n${HANDOFF_TEXT}`,
    reactionGuidance: DISCORD_DETECT_GUIDANCE,
  });
  assert.deepEqual(
    h.fetchCalls.filter((c) => c.channel === "t1" && c.before !== undefined),
    [{ channel: "t1", limit: 25, before: "1300000000000000009" }],
  );
  assert.equal(body.text, "@qm and now?");
});

test("the first turn in a new thread reads the parent channel before the trigger and says it opened the thread", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    parentHistory: [{ id: "1300000000000000001", content: "the build is red", author: BO }],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", { ...h.message, id: "1300000000000000005" });
  await h.settle();
  await h.plugin.stop();
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.deepEqual(body.priorTurns, [{ role: "user", name: "bo", text: "[~9vkbjfeanyf5] the build is red" }]);
  assert.match(String(body.conversationHeader), /You are replying in a thread you started\.$/);
  assert.deepEqual(
    h.fetchCalls.filter((c) => c.before !== undefined),
    [{ channel: "c1", limit: 25, before: "1300000000000000005" }],
  );
});

test("the thread starter leads the context and a thread someone else opened names its starter", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    threadOwnerId: "222",
    threadStarter: { id: "1300000000000000000", content: "release 4.2 plan", author: BO },
    threadHistory: [{ id: "1300000000000000001", content: "approved", author: ANA }],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", inThread(h, { id: "1300000000000000009", content: "<@999> ship it" }));
  await h.settle();
  await h.plugin.stop();
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.deepEqual(body.priorTurns, [
    { role: "user", text: "bo: [~9vkbjfeanyf4] release 4.2 plan\nana: [~9vkbjfeanyf5] approved" },
  ]);
  assert.match(String(body.conversationHeader), /You are replying in a thread @bo started\.$/);
  assert.equal(body.detectOpener, undefined);
});

test("a thread the bot opened exposes its starter text as the detect opener", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    threadStarter: { id: "1300000000000000000", content: "<@999> deploy it", author: ANA },
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", inThread(h, { id: "1300000000000000009", content: "<@999> status?" }));
  await h.settle();
  await h.plugin.stop();
  assert.equal((h.submitted[0] as Record<string, unknown>).detectOpener, "<@999> deploy it");
});

test("when history cannot be read the turn still goes out with a note and no turns", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    threadHistoryFails: true,
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", inThread(h, { id: "1300000000000000009", content: "<@999> status?" }));
  await h.settle();
  await h.plugin.stop();
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.equal(body.priorTurns, undefined);
  assert.match(
    String(body.conversationHeader),
    /Discord context could not be read; earlier messages may be missing\.$/,
  );
});

test("a channel a guest can read gets no history read at all", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "300", roles: [] },
    ],
    threadHistory: [{ id: "1300000000000000001", content: "private chatter", author: ANA }],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", inThread(h, { id: "1300000000000000009", content: "<@999> status?" }));
  await h.settle();
  await h.plugin.stop();
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.equal(body.priorTurns, undefined);
  assert.equal(body.overheard, undefined);
  assert.equal(body.conversationHeader, undefined);
  assert.deepEqual(
    h.fetchCalls.filter((c) => c.before !== undefined),
    [],
  );
});

test("a DM turn sends the gateway context and no history", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    id: "d1",
    channelId: "dm1",
    guildId: null,
    guild: null,
    content: "hello",
    mentions: { users: new Map() },
    channel: {
      type: ChannelType.DM,
      isThread: () => false,
      send: async () => ({ id: "s9", edit: async () => {}, delete: async () => {} }),
      sendTyping: async () => {},
    },
  });
  await h.settle();
  await h.plugin.stop();
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.deepEqual(body.gatewayContext, {
    location: "a direct message with the user",
    details: { channel: "dm1" },
    reactionGuidance: DISCORD_DETECT_GUIDANCE,
  });
  assert.equal(body.priorTurns, undefined);
  assert.equal(h.fetchCalls.length, 0);
});

test("a linked-internal bot mention opens a bot-actor turn even when the bot is not in the member cache", async () => {
  const h = guildHarness({
    authorRoles: [],
    viewers: [{ id: "111", roles: ["staff"] }],
    internalUserIds: ["555"],
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    author: { id: "555", username: "ciBot", bot: true, globalName: null },
    member: { id: "555", displayName: "ciBot", user: { id: "555", bot: true }, roles: { cache: new Map() } },
    content: "<@999> deploy failed",
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  const body = h.submitted[0]! as { botActor?: boolean; actor: { isBot?: boolean }; text: string };
  assert.equal(body.botActor, true);
  assert.equal(body.actor.isBot, true);
  assert.equal(body.text, "@qm deploy failed");
});

test("a bot that is not linked-internal is an outside guest and submits nothing even when it mentions the bot", async () => {
  const h = guildHarness({ authorRoles: [], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    author: { id: "556", username: "spam", bot: true, globalName: null },
    member: { id: "556", displayName: "spam", user: { id: "556", bot: true }, roles: { cache: new Map() } },
  });
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.submitted, []);
});

test("a human author never gets botActor", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal("botActor" in (h.submitted[0] as object), false);
});

test("a reply to another message submits the referenced author and excerpt ahead of the text", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    reference: { messageId: "p1", type: 0 },
    fetchReference: async () => ({
      member: { displayName: "Bo" },
      author: { globalName: null, username: "bo" },
      content: "the build is red",
    }),
  });
  await h.settle();
  await h.plugin.stop();
  assert.equal((h.submitted[0] as { text: string }).text, "[in reply to Bo] the build is red\n@qm deploy it");
});

test("the new thread is named from the message without the bot mention", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const names: string[] = [];
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", {
    ...h.message,
    startThread: async (o: { name: string }) => {
      names.push(o.name);
      return h.thread;
    },
  });
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(names, ["deploy it"]);
});

const EDIT_AT = 1_800_000_000_000;
const MSG_ID = "1300000000000000001";
const MSG_ID_CREATED_MS = 1_730_014_552_832;

test("the real client asks for message partials and the message intents that deliver edits and deletes", () => {
  assert.ok(DISCORD_CLIENT_OPTIONS.partials?.includes(Partials.Message));
  assert.ok(DISCORD_CLIENT_OPTIONS.partials?.includes(Partials.Channel));
  assert.ok((DISCORD_CLIENT_OPTIONS.intents as GatewayIntentBits[]).includes(GatewayIntentBits.GuildMessages));
});

async function emitAndSettle(h: ReturnType<typeof guildHarness>, event: string, ...args: unknown[]) {
  await h.plugin.start();
  await h.settle();
  h.emitter.emit(event, ...args);
  await h.settle();
  await h.plugin.stop();
}

test("an edit of a mention message is mirrored with its edit time and new text", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageUpdate", h.message, {
    ...h.message,
    id: MSG_ID,
    content: "<@999> deploy it now",
    editedTimestamp: EDIT_AT,
  });
  assert.equal(h.ingested.length, 1);
  const e = (h.ingested[0] as Array<Record<string, unknown>>)[0]!;
  assert.equal(e.container, "c1");
  assert.equal(e.ts, MSG_ID);
  assert.equal(e.text, "<@999> deploy it now");
  assert.equal(e.editedAt, EDIT_AT);
  assert.equal(e.createdAt, MSG_ID_CREATED_MS);
  assert.equal(e.deleted, undefined);
  assert.deepEqual(h.submitted, []);
});

test("an embed-only update carries no edit time and is not mirrored", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageUpdate", h.message, { ...h.message, id: MSG_ID, editedTimestamp: null });
  assert.deepEqual(h.ingested, []);
});

test("an edit of an unrelated message in a configured guild is not mirrored", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageUpdate", h.message, {
    ...h.message,
    id: MSG_ID,
    content: "lunch?",
    mentions: { users: new Map() },
    editedTimestamp: EDIT_AT,
  });
  assert.deepEqual(h.ingested, []);
});

test("an edit in an unconfigured guild is dropped", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageUpdate", h.message, {
    ...h.message,
    id: MSG_ID,
    guildId: "777",
    editedTimestamp: EDIT_AT,
  });
  assert.deepEqual(h.ingested, []);
});

test("an edit of a message in a staked thread is mirrored without a mention", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  h.emitter.emit(
    "messageUpdate",
    h.message,
    inThread(h, { id: MSG_ID, content: "fixed typo", mentions: { users: new Map() }, editedTimestamp: EDIT_AT }),
  );
  await h.settle();
  await h.plugin.stop();
  const edits = h.ingested.flat().filter((e) => (e as { editedAt?: number }).editedAt !== undefined);
  assert.equal(edits.length, 1);
  assert.equal((edits[0] as { container: string }).container, "t1");
});

test("a partial update is fetched before it is mirrored, and a failed fetch is swallowed", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const full = { ...h.message, id: MSG_ID, content: "<@999> v2", editedTimestamp: EDIT_AT };
  await emitAndSettle(h, "messageUpdate", h.message, { partial: true, guildId: "900", fetch: async () => full });
  assert.equal(h.ingested.length, 1);
  assert.equal((h.ingested[0] as Array<{ text: string }>)[0]!.text, "<@999> v2");

  const g = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(g, "messageUpdate", g.message, {
    partial: true,
    guildId: "900",
    fetch: async () => {
      throw new Error("Unknown Message");
    },
  });
  assert.deepEqual(g.ingested, []);
});

test("a partial update from a guild that is not configured is never fetched", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  let fetched = 0;
  await emitAndSettle(h, "messageUpdate", h.message, {
    partial: true,
    guildId: "777",
    fetch: async () => (fetched++, { ...h.message, guildId: "777", editedTimestamp: EDIT_AT }),
  });
  assert.equal(fetched, 0);
  assert.deepEqual(h.ingested, []);
});

test("deleting a cached mention message mirrors a tombstone for its container and id", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageDelete", { ...h.message, id: MSG_ID, partial: false });
  assert.deepEqual(h.ingested, [[{ container: "c1", ts: MSG_ID, deleted: true, kind: "channel" }]]);
});

test("deleting the bot's own cached message marks the tombstone as self", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageDelete", {
    ...h.message,
    id: MSG_ID,
    partial: false,
    author: SELF,
    content: "done",
    mentions: { users: new Map() },
  });
  assert.deepEqual(h.ingested, [[{ container: "c1", ts: MSG_ID, deleted: true, kind: "channel", self: true }]]);
});

test("deleting an unrelated cached message mirrors nothing", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(h, "messageDelete", {
    ...h.message,
    partial: false,
    content: "lunch?",
    mentions: { users: new Map() },
  });
  assert.deepEqual(h.ingested, []);
});

test("deleting an uncached message in a configured guild mirrors a tombstone, elsewhere nothing", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const partial = { partial: true, id: MSG_ID, channelId: "c1", guildId: "900", author: null };
  await emitAndSettle(h, "messageDelete", partial);
  assert.deepEqual(h.ingested, [[{ container: "c1", ts: MSG_ID, deleted: true, kind: "channel" }]]);

  const g = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await emitAndSettle(g, "messageDelete", { ...partial, guildId: "777" });
  await emitAndSettle(g, "messageDelete", { ...partial, guildId: null });
  assert.deepEqual(g.ingested, []);
});

test("a bulk delete mirrors a tombstone for each message", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const rows = ["1300000000000000001", "1300000000000000002"].map((id) => ({
    partial: true,
    id,
    channelId: "c1",
    guildId: "900",
    author: null,
  }));
  await emitAndSettle(h, "messageDeleteBulk", new Map(rows.map((r) => [r.id, r])));
  assert.deepEqual(
    h.ingested.flat().map((e) => (e as { ts: string }).ts),
    ["1300000000000000001", "1300000000000000002"],
  );
});

const DEFAULT_ACK_CHARS = ["👀", "🔍", "⏳", "🔭", "🫡"];
function gatedSubmit() {
  const gates: Array<() => void> = [];
  return {
    submit: () => new Promise<Record<string, unknown>>((r) => gates.push(() => r({ status: "silent" }))),
    release: () => gates.splice(0).forEach((open) => open()),
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function startWithMockedTimeouts(h: ReturnType<typeof guildHarness>) {
  await h.plugin.start();
  await h.settle();
  mock.timers.enable({ apis: ["setTimeout"] });
}

async function stopWithRealTimeouts(h: ReturnType<typeof guildHarness>) {
  mock.timers.reset();
  await h.plugin.stop();
}

test("a slow prompted guild turn reacts on the trigger message and removes the same reaction when it settles", async () => {
  const gate = gatedSubmit();
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: gate.submit,
  });
  await startWithMockedTimeouts(h);
  h.emitter.emit("messageCreate", h.message);
  await flush();
  mock.timers.tick(ACK_REACTION_DELAY_MS);
  await flush();
  gate.release();
  await flush();
  await stopWithRealTimeouts(h);
  assert.equal(h.reactions.length, 2);
  const [added, removed] = h.reactions as [string, string];
  assert.ok(DEFAULT_ACK_CHARS.includes(added.slice(1)));
  assert.equal(added[0], "+");
  assert.equal(removed, `-${added.slice(1)}`);
});

test("a fast turn never reacts", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
  });
  await startWithMockedTimeouts(h);
  h.emitter.emit("messageCreate", h.message);
  await flush();
  mock.timers.tick(ACK_REACTION_DELAY_MS);
  await flush();
  await stopWithRealTimeouts(h);
  assert.deepEqual(h.reactions, []);
});

test("an unprompted follow-up gets no acknowledgement reaction even when it runs long", async () => {
  const gate = gatedSubmit();
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: gate.submit,
  });
  await startWithMockedTimeouts(h);
  h.emitter.emit("messageCreate", h.message);
  await flush();
  mock.timers.tick(ACK_REACTION_DELAY_MS);
  await flush();
  gate.release();
  await flush();
  h.reactions.length = 0;
  h.emitter.emit(
    "messageCreate",
    inThread(h, { id: "1300000000000000009", content: "no mention", mentions: { users: new Map() } }),
  );
  await flush();
  mock.timers.tick(ACK_REACTION_DELAY_MS);
  await flush();
  gate.release();
  await flush();
  await stopWithRealTimeouts(h);
  assert.equal(h.submitted.length, 2);
  assert.deepEqual(h.reactions, []);
});

test("editing the mention out of a mirrored message still records the edit", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", { ...h.message, id: MSG_ID });
  await h.settle();
  h.emitter.emit("messageUpdate", h.message, {
    ...h.message,
    id: MSG_ID,
    content: "never mind",
    mentions: { users: new Map() },
    editedTimestamp: EDIT_AT,
  });
  await h.settle();
  await h.plugin.stop();
  const edits = h.ingested.flat().filter((e) => (e as { editedAt?: number }).editedAt !== undefined);
  assert.equal(edits.length, 1);
  assert.equal((edits[0] as { text: string }).text, "never mind");
});

test("deleting a mirrored message whose mention was edited out still records the tombstone", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", { ...h.message, id: MSG_ID });
  await h.settle();
  h.emitter.emit("messageDelete", {
    ...h.message,
    id: MSG_ID,
    partial: false,
    content: "never mind",
    mentions: { users: new Map() },
  });
  await h.settle();
  await h.plugin.stop();
  const tombstones = h.ingested.flat().filter((e) => (e as { deleted?: boolean }).deleted === true);
  assert.deepEqual(tombstones, [{ container: "c1", ts: MSG_ID, deleted: true, kind: "channel" }]);
});

const REACTOR = { id: "111", partial: false, bot: false, username: "ana", globalName: null };

function reactionEvent(
  h: ReturnType<typeof guildHarness>,
  over: { author?: typeof ANA; channel?: unknown; hasThread?: boolean; guildId?: string | null; thread?: unknown } = {},
) {
  const message: Record<string, unknown> = {
    id: "1300000000000000001",
    channelId: "t1",
    guildId: over.guildId === undefined ? "900" : over.guildId,
    guild: h.message.guild,
    author: over.author ?? SELF,
    content: "all deployed",
    mentions: { users: new Map() },
    attachments: new Map(),
    reactions: { cache: new Map() },
    channel: over.channel ?? h.thread,
    hasThread: over.hasThread ?? false,
    thread: over.thread,
    partial: false,
    startThread: async () => {
      h.threads.push("t1");
      return h.thread;
    },
  };
  message.fetch = async () => message;
  const emoji = { name: "👍", id: null };
  return { reaction: { partial: false, emoji, message }, message };
}

const REACTION_TEXT = '[Discord reaction] u111 reacted with :+1: on your message: "all deployed".';

test("a reaction on the bot's thread message becomes an unprompted turn that can still react", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: async () => ({ status: "react", reactions: ["tada"] }),
  });
  const { reaction } = reactionEvent(h);
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.equal(h.submitted.length, 1);
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.equal(body.text, REACTION_TEXT);
  assert.equal(body.unprompted, true);
  assert.equal(body.triggerTs, undefined);
  assert.equal((body.gatewayContext as Record<string, unknown>).reactionGuidance, DISCORD_DETECT_GUIDANCE);
  assert.deepEqual(h.reactions, ["+🎉"]);
});

test("a removed reaction says it was removed", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction } = reactionEvent(h);
  await emitAndSettle(h, "messageReactionRemove", reaction, REACTOR);
  assert.equal(
    (h.submitted[0]! as Record<string, unknown>).text,
    '[Discord reaction] u111 removed their :+1: reaction from your message: "all deployed".',
  );
});

test("a reaction on someone else's message in a thread the bot has no stake in starts no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction } = reactionEvent(h, { author: BO });
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.deepEqual(h.submitted, []);
});

test("a reaction on a followed thread root starts a turn naming the root's author", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    threadHistory: [{ id: "1300000000000000005", content: "on it", author: SELF }],
  });
  const { reaction } = reactionEvent(h, { author: BO, channel: h.message.channel, hasThread: true, thread: h.thread });
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.equal(
    (h.submitted[0]! as Record<string, unknown>).text,
    `[Discord reaction] u111 reacted with :+1: on bo's message: "all deployed".`,
  );
});

test("a root with a thread the bot never spoke in starts no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction } = reactionEvent(h, { author: BO, channel: h.message.channel, hasThread: true, thread: h.thread });
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.deepEqual(h.submitted, []);
});

test("the bot's own reaction starts no turn even when the bot is linked as internal", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    internalUserIds: ["999"],
  });
  const { reaction } = reactionEvent(h);
  await emitAndSettle(h, "messageReactionAdd", reaction, { ...REACTOR, id: "999", bot: true });
  assert.deepEqual(h.submitted, []);
});

test("a guest reactor in a DM starts no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const dm = { id: "d1", type: ChannelType.DM, isThread: () => false, isTextBased: () => true };
  const { reaction } = reactionEvent(h, { channel: dm, guildId: null });
  await emitAndSettle(h, "messageReactionAdd", reaction, { ...REACTOR, id: "333", username: "zed" });
  assert.deepEqual(h.submitted, []);
});

test("an internal reactor in a thread whose parent a guest can read starts no turn", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [
      { id: "111", roles: ["staff"] },
      { id: "444", roles: [] },
    ],
  });
  const { reaction } = reactionEvent(h);
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.deepEqual(h.submitted, []);
});

test("a reaction in an unconfigured guild is dropped before any fetch", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction, message } = reactionEvent(h, { guildId: "777" });
  let fetches = 0;
  message.partial = true;
  message.fetch = async () => {
    fetches += 1;
    return message;
  };
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.equal(fetches, 0);
  assert.deepEqual(h.submitted, []);
});

test("a reaction on the bot's top-level channel message opens a thread under it and runs a turn there", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction } = reactionEvent(h, { channel: h.message.channel });
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.deepEqual(h.threads, ["t1"]);
  const body = h.submitted[0]! as { conversation: Record<string, unknown>; text: string };
  assert.equal(body.conversation.threadRef, "discord:th:t1");
  assert.equal(body.text, REACTION_TEXT);
});

test("a reaction on someone else's top-level channel message opens no thread", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction } = reactionEvent(h, { author: BO, channel: h.message.channel });
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.deepEqual([h.threads, h.submitted], [[], []]);
});

test("a reaction in a DM starts an unprompted dm turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const dmChannel = {
    id: "d1",
    type: ChannelType.DM,
    isThread: () => false,
    isTextBased: () => true,
    send: async () => ({ id: "s9", edit: async () => {}, delete: async () => {} }),
    sendTyping: async () => {},
  };
  const { reaction } = reactionEvent(h, { channel: dmChannel, guildId: null });
  (reaction.message as Record<string, unknown>).channelId = "d1";
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  const body = h.submitted[0]! as Record<string, unknown>;
  assert.equal((body.conversation as Record<string, unknown>).kind, "dm");
  assert.equal(body.unprompted, true);
  assert.equal(body.text, REACTION_TEXT);
});

test("removing a reaction from a top-level bot message opens no thread and runs no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const { reaction } = reactionEvent(h, { channel: h.message.channel });
  await emitAndSettle(h, "messageReactionRemove", reaction, REACTOR);
  assert.deepEqual([h.threads, h.submitted], [[], []]);
});

test("when another reaction already opened the thread, the turn continues in it and does not delete it", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: async () => ({ status: "silent" }),
  });
  const { reaction, message } = reactionEvent(h, { channel: h.message.channel });
  message.startThread = async () => {
    throw Object.assign(new Error("thread exists"), { code: 160004 });
  };
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.equal(h.submitted.length, 1);
  assert.deepEqual([h.threads, h.threadDeletes], [[], []]);
});

test("the turn that created a reaction thread does not delete it after another reaction raced into it", async () => {
  const releases: Array<() => void> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: () => new Promise((r) => releases.push(() => r({ status: "silent" }))),
  });
  const { reaction, message } = reactionEvent(h, { channel: h.message.channel });
  let starts = 0;
  message.startThread = async () => {
    if (starts++ > 0) throw Object.assign(new Error("thread exists"), { code: 160004 });
    h.threads.push("t1");
    return h.thread;
  };
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageReactionAdd", reaction, REACTOR);
  await h.settle();
  h.emitter.emit("messageReactionAdd", { ...reaction, emoji: { name: "🎉", id: null } }, REACTOR);
  await h.settle();
  assert.equal(releases.length, 2);
  releases[0]!();
  await h.settle();
  releases[1]!();
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual([h.threads, h.threadDeletes], [["t1"], []]);
});

test("a thread another reaction resolves while the creating turn's empty probe is in flight is not deleted", async () => {
  let release!: () => void;
  const probeGate = new Promise<void>((resolve) => (release = resolve));
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: async () => ({ status: "silent" }),
    probeGate,
  });
  const first = reactionEvent(h, { channel: h.message.channel });
  const second = reactionEvent(h, { channel: h.message.channel, hasThread: true, thread: h.thread });
  second.message.id = "1300000000000000002";
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageReactionAdd", first.reaction, REACTOR);
  await h.settle();
  h.emitter.emit("messageReactionAdd", second.reaction, REACTOR);
  await h.settle();
  release();
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual([h.threads, h.threadDeletes], [["t1"], []]);
});

test("a DM reaction whose channel is not a DM starts no turn", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  const notDm = { id: "d1", type: ChannelType.GuildText, isThread: () => false, isTextBased: () => true };
  const { reaction } = reactionEvent(h, { channel: notDm, guildId: null });
  await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
  assert.deepEqual(h.submitted, []);
});

test("the client subscribes to guild and DM reaction events with reaction partials", () => {
  const intents = DISCORD_CLIENT_OPTIONS.intents as GatewayIntentBits[];
  assert.ok(intents.includes(GatewayIntentBits.GuildMessageReactions));
  assert.ok(intents.includes(GatewayIntentBits.DirectMessageReactions));
  assert.ok(DISCORD_CLIENT_OPTIONS.partials?.includes(Partials.Reaction));
  assert.ok(DISCORD_CLIENT_OPTIONS.partials?.includes(Partials.User));
});

const BACKFILL_FLOOR_CLEAR = 60_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const recentId = (n: number): string =>
  ((BigInt(Date.now() - BACKFILL_FLOOR_CLEAR - DISCORD_EPOCH_MS) << 22n) + BigInt(n)).toString();
const WATERMARK = "1000000000000000";

test("after the members hydrate, a mention that arrived while offline is caught up", async () => {
  const id = recentId(7);
  const rows: Array<Record<string, unknown>> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "c1", lastTs: WATERMARK }],
    backfillRows: rows,
  });
  rows.push({ ...h.message, id });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
  assert.equal((h.submitted[0] as { redeliveryKey: string }).redeliveryKey, `discord:${id}`);
  assert.deepEqual(h.threads, ["t1"]);
  const sweeps = h.fetchCalls.filter((c) => c.limit === 100 && !c.before);
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0]!.channel, "c1");
});

test("a backfilled mention that already has a thread is not answered again", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "c1", lastTs: WATERMARK }],
    backfillRows: rows,
  });
  rows.push({ ...h.message, id: recentId(8), hasThread: true });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.fetchCalls.filter((c) => c.limit === 100 && !c.before).length, 1);
  assert.deepEqual(h.submitted, []);
});

test("a full backfill page notes a history gap on the parent channel", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "t1", lastTs: WATERMARK }],
    backfillRows: Array.from({ length: 100 }, (_, i) => ({ id: recentId(i), hasThread: true })),
  });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.gapNotes.length, 1);
  assert.equal(h.gapNotes[0]!.channelId, "c1");
  assert.match(h.gapNotes[0]!.note, /partly caught up/);
});

test("a backfilled unprompted message in a staked thread is mirrored only and starts no turn", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "t1", lastTs: WATERMARK }],
    backfillRows: rows,
  });
  const id = recentId(9);
  const row = {
    ...h.message,
    id,
    channelId: "t1",
    content: "following up",
    mentions: { users: new Map() },
    channel: h.thread,
  };
  rows.push({ ...row, id: recentId(8), author: { id: "999", username: "qm", bot: true, globalName: null } }, row);
  await h.plugin.start();
  await h.settle();
  const caughtUp = h.ingested.flat().some((e) => (e as { ts?: string }).ts === id);
  assert.deepEqual(h.submitted, []);
  assert.ok(caughtUp);
  h.emitter.emit("messageCreate", { ...row, id: recentId(10) });
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.submitted.length, 1);
});

test("a thread opened for a reaction is kept once another turn has resolved it, even if that turn ends first", async () => {
  const releases: Array<() => void> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    submitResult: () => new Promise((r) => releases.push(() => r({ status: "silent" }))),
  });
  const first = reactionEvent(h, { channel: h.message.channel });
  const second = reactionEvent(h, { channel: h.message.channel, hasThread: true, thread: h.thread });
  second.message.id = "1300000000000000002";
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageReactionAdd", first.reaction, REACTOR);
  await h.settle();
  h.emitter.emit("messageReactionAdd", second.reaction, REACTOR);
  await h.settle();
  assert.equal(releases.length, 2);
  releases[1]!();
  await h.settle();
  releases[0]!();
  await h.settle();
  assert.deepEqual(h.threadDeletes, []);
  await h.plugin.stop();
});

test("a mention answered with the readers-unknown notice is not re-run when the session resumes", async () => {
  const id = recentId(11);
  const rows: Array<Record<string, unknown>> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "c1", lastTs: WATERMARK }],
    backfillRows: rows,
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("shardReconnecting", 0);
  h.emitter.emit("messageCreate", { ...h.message, id });
  await h.settle();
  assert.deepEqual(h.submitted, []);
  rows.push({ ...h.message, id });
  h.emitter.emit("shardResume", 0, 0);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(h.channelPosts, [
    "I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.",
  ]);
  assert.deepEqual(h.submitted, []);
});

test("a thread is fetched even when its cached last message id is not past the cursor", async () => {
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "t1", lastTs: WATERMARK }],
    threadLastMessageId: "1",
  });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.fetchCalls.filter((c) => c.channel === "t1" && c.limit === 100 && !c.before).length, 1);
});

test("a mention noticed at the gates is not re-run even when an earlier mention set the in-process cursor", async () => {
  const first = recentId(20);
  const dropped = recentId(21);
  const rows: Array<Record<string, unknown>> = [];
  const h = guildHarness({
    authorRoles: ["staff"],
    viewers: [{ id: "111", roles: ["staff"] }],
    watermarks: [{ container: "c1", lastTs: dropped }],
    backfillRows: rows,
  });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", { ...h.message, id: first });
  await h.settle();
  h.emitter.emit("shardReconnecting", 0);
  h.emitter.emit("messageCreate", { ...h.message, id: dropped });
  await h.settle();
  rows.push({ ...h.message, id: dropped });
  h.emitter.emit("shardResume", 0, 0);
  await h.settle();
  await h.plugin.stop();
  assert.deepEqual(
    h.submitted.map((x) => (x as { redeliveryKey: string }).redeliveryKey),
    [`discord:${first}`],
  );
});

const REACTION_THREAD_CASES: Array<{
  label: string;
  submitResult: () => Promise<Record<string, unknown>>;
  waitRun?: () => Promise<unknown>;
  threadMessages?: Map<string, unknown>;
  deleted: boolean;
}> = [
  {
    label: "the turn ends silent with nothing to post",
    submitResult: async () => ({ status: "silent" }),
    deleted: true,
  },
  {
    label: "the turn ends with only a reaction",
    submitResult: async () => ({ status: "react", reactions: ["tada"] }),
    deleted: true,
  },
  {
    label: "the turn has a reply to deliver",
    submitResult: async () => ({ status: "ok", reply: "hi" }),
    deleted: false,
  },
  {
    label: "the thread already has messages",
    submitResult: async () => ({ status: "silent" }),
    threadMessages: new Map([["m1", {}]]),
    deleted: false,
  },
  {
    label: "a thread holding only the starter message counts as empty and is deleted",
    submitResult: async () => ({ status: "silent" }),
    threadMessages: new Map([["s0", { type: MessageType.ThreadStarterMessage }]]),
    deleted: true,
  },
  {
    label: "the turn ends refused",
    submitResult: async () => ({ status: "refused", reason: "no" }),
    deleted: true,
  },
  {
    label: "the turn ends pending approval",
    submitResult: async () => ({ status: "pending_approval" }),
    deleted: false,
  },
  {
    label: "the turn fails",
    submitResult: async () => {
      throw new Error("boom");
    },
    deleted: true,
  },
  {
    label: "the run ends failed",
    submitResult: async () => ({ status: "failed" }),
    deleted: true,
  },
  {
    label: "the run ends without a result",
    submitResult: async () => ({ status: "queued", runId: "r1" }),
    waitRun: async () => null,
    deleted: true,
  },
  {
    label: "the wait for its run throws",
    submitResult: async () => ({ status: "queued", runId: "r1" }),
    waitRun: async () => {
      throw new Error("stall budget");
    },
    deleted: false,
  },
];

test("a thread opened for a reaction is deleted or kept by how the turn ends", async () => {
  for (const { label, submitResult, waitRun, threadMessages, deleted } of REACTION_THREAD_CASES) {
    const h = guildHarness({
      authorRoles: ["staff"],
      viewers: [{ id: "111", roles: ["staff"] }],
      submitResult,
      ...(threadMessages ? { threadMessages } : {}),
    });
    if (waitRun) (h.core as unknown as { waitRun: () => Promise<unknown> }).waitRun = waitRun;
    const { reaction } = reactionEvent(h, { channel: h.message.channel });
    await emitAndSettle(h, "messageReactionAdd", reaction, REACTOR);
    assert.deepEqual([h.threads, h.threadDeletes], [["t1"], deleted ? ["t1"] : []], label);
  }
});

test("a prompted message that stays unclassifiable is told readers are unknown only once", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [], hydrationFails: true });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("messageCreate", h.message);
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.channelPosts.length, 1);
});

test("a prompted message dropped for unknown readers is told so only once across replays", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  h.emitter.emit("shardReconnecting", 0);
  h.emitter.emit("messageCreate", h.message);
  h.emitter.emit("messageCreate", h.message);
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.channelPosts.length, 1);
});

test("one connection start fetches the guild members once even though ShardReady and ClientReady both fire", async () => {
  const h = guildHarness({ authorRoles: ["staff"], viewers: [{ id: "111", roles: ["staff"] }] });
  await h.plugin.start();
  await h.settle();
  await h.plugin.stop();
  assert.equal(h.memberFetches(), 1);
});
