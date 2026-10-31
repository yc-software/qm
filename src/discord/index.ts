import {
  ChannelType,
  Client,
  Events,
  MessageFlags,
  MessageType,
  RESTJSONErrorCodes,
  type AnyThreadChannel,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { LRUCache } from "lru-cache";
import type { CoreTurnBody } from "../api/surface-core-client.ts";
import type { DiscordCoreClient } from "../api/discord-core-client.ts";
import type { IngestEvent } from "../surface-cache/types.ts";
import { buildReactionTurnText, REACTION_ITEM_MESSAGE, shouldSurfaceReaction } from "../surfaces/reactions.ts";
import type { ActorAssertion } from "../types.ts";
import type { SurfaceContextRequest } from "../reach/reach.ts";
import { jitteredBackoffMs } from "../util/async.ts";
import { reportFailureAs, swallow, swallowAs } from "../util/errors.ts";
import { createSweeper } from "../util/sweeper.ts";
import { createDiscordAck } from "./ack.ts";
import { createBackfill, type Backfill } from "./backfill.ts";
import { ingestAttachments } from "./attachments.ts";
import { createCardRenderer } from "./approval-cards.ts";
import {
  DISCORD_RETRY_BASE_MS,
  DISCORD_RETRY_MAX_MS,
  DISCORD_SURFACE,
  recipientDiscordId,
  type DiscordPluginConfig,
} from "./config.ts";
import { createDeliveryGuard, createDiscordDispatcher } from "./deliveries.ts";
import {
  conversationFor,
  deliveryTargetFor,
  needsStakeLookup,
  routeMessage,
  threadName,
  type DiscordAttachmentRef,
  type DiscordInbound,
} from "./events.ts";
import {
  computeDiscordRoster,
  createChannelRosterSync,
  DISCORD_ROSTER_RETRY_MS,
  syncDirectoryAndRosters,
} from "./channel-roster.ts";
import { createDirectorySync, DISCORD_DIRECTORY_SYNC_MS } from "./directory.ts";
import { createInteractionHandler } from "./interactions.ts";
import { buildGuildTurnContext, gatewayContextFor } from "./conversation-context.ts";
import { createChannelLookup, createContextFulfiller, type DiscordHistoryReader } from "./context.ts";
import { withReplyContext } from "./forwards.ts";
import {
  cachedPeople,
  channelViewers,
  createChannelKind,
  createDiscordChannels,
  createDiscordHistoryReader,
  createMergedClassify,
  createStakeHistory,
  createUserClassifier,
  displayNameOf,
  scopeChannelId,
  toInbound,
  type DiscordChannels,
} from "./gateway.ts";
import { DISCORD_CLIENT_OPTIONS, replyChannel } from "./client.ts";
import { createMemberHydrator } from "./member-hydrator.ts";
import { shouldMirror, toDeleteEvent, toEditEvent, toIngestEvent } from "./mirror.ts";
import { audienceWith, channelReaders, turnPostGate, type ReaderResult } from "./readers.ts";
import { createDiscordSender, NO_MENTIONS, sendable, type DiscordSender } from "./sender.ts";
import { createStakeTracker, type StakeTracker } from "./thread-stake.ts";
import { applyDiscordReactions, emojiDisplayName, reactionTallies, type MessageTarget } from "./reactions.ts";
import { runDiscordTurn, type ReactHandler } from "./turn-flow.ts";

type StreamGate = () => Promise<boolean>;
const allowDmStream: StreamGate = async () => true;

const MIRRORED_MESSAGES_MAX = 5_000;
const THREAD_EMPTY_PROBE = 2;
export const DISCORD_DELIVERY_POLL_MS = 60_000;
const READERS_UNKNOWN_TEXT =
  "I can't confirm who can read this channel right now, so I won't answer here yet. Try again in a minute.";
const UNKNOWN_READER: ActorAssertion = {
  externalId: `${DISCORD_SURFACE}:unreadable-channel`,
  isExternalGuest: true,
};

export interface DiscordPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordPluginOptions {
  clientFactory?: () => Client;
  drainTimeoutMs: number;
  webUiPublicUrl?: string;
}

interface ConnectionScope {
  channels: DiscordChannels;
  classifyUser: (userId: string, fallbackName: string) => Promise<ActorAssertion | null>;
  readersOf: (channelId: string) => Promise<ReaderResult>;
  stakes: StakeTracker;
  historyReader: DiscordHistoryReader;
  sender: DiscordSender;
  backfill: Backfill;
}

export function createDiscordPlugin(
  cfg: DiscordPluginConfig,
  core: DiscordCoreClient,
  opts: DiscordPluginOptions,
): DiscordPlugin {
  const clientFactory = opts.clientFactory ?? (() => new Client(DISCORD_CLIENT_OPTIONS));
  const drainTimeoutMs = opts.drainTimeoutMs;
  const inFlightRuns = new Set<string>();
  const ownedRuns = new Set<string>();

  let client: Client | null = null;
  let detachClient: (() => { client: Client; inFlight: Set<Promise<void>> }) | null = null;
  let stopPromise: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let loginFailures = 0;
  let stopped = true;

  const reactionsInFlight = new Set<string>();
  const sharedThreads = new LRUCache<string, true>({ max: MIRRORED_MESSAGES_MAX });
  const unknownNoticed = new LRUCache<string, true>({ max: MIRRORED_MESSAGES_MAX });
  const mirrored = new LRUCache<string, true>({ max: MIRRORED_MESSAGES_MAX });
  const mirroredKey = (channelId: string, messageId: string): string => `${channelId}:${messageId}`;

  function mirrorEvent(c: Client, event: IngestEvent): void {
    if (!event.deleted) mirrored.set(mirroredKey(event.container, event.ts), true);
    void core
      .ingestSurfaceEvents([event], { name: c.user?.tag, mentionId: c.user?.id ?? "" })
      .catch(swallowAs("discord: mirror", undefined));
  }

  const unconfiguredGuild = (guildId: string | null): boolean => guildId !== null && !cfg.guildIds.has(guildId);

  async function linkActivePrivateThreads(c: Client, channels: DiscordChannels, guildId: string): Promise<void> {
    const { threads } = await (await c.guilds.fetch(guildId)).channels.fetchActiveThreads();
    for (const thread of threads.values())
      await channels.linked(thread).catch(swallowAs("discord: private thread link", undefined));
  }

  async function stakedIn(run: ConnectionScope, inbound: DiscordInbound, botUserId: string): Promise<boolean> {
    return needsStakeLookup(inbound, botUserId) ? run.stakes.has(inbound.channelId, botUserId) : false;
  }

  async function tracked(run: ConnectionScope, inbound: DiscordInbound, botUserId: string): Promise<boolean> {
    return (
      shouldMirror(inbound, botUserId, await stakedIn(run, inbound, botUserId)) ||
      mirrored.has(mirroredKey(inbound.channelId, inbound.id))
    );
  }

  async function handleEdit(message: Message, c: Client, run: ConnectionScope): Promise<void> {
    if (message.guildId === null || unconfiguredGuild(message.guildId)) return;
    const full = message.partial ? await message.fetch() : message;
    if (full.editedTimestamp === null) return;
    const botUserId = c.user?.id ?? "";
    const inbound = toInbound(full);
    if (await tracked(run, inbound, botUserId)) mirrorEvent(c, toEditEvent(inbound, botUserId, full.editedTimestamp));
  }

  async function handleDelete(message: Message | PartialMessage, c: Client, run: ConnectionScope): Promise<void> {
    if (message.guildId === null || unconfiguredGuild(message.guildId)) return;
    const botUserId = c.user?.id ?? "";
    if (!message.partial && !(await tracked(run, toInbound(message), botUserId))) return;
    mirrorEvent(c, toDeleteEvent(message.channelId, message.id, message.author?.id === botUserId));
  }

  async function noticeReadersUnknown(message: Message, accepted: () => void): Promise<void> {
    accepted();
    if (unknownNoticed.has(message.id)) return;
    unknownNoticed.set(message.id, true);
    await message.reply({ content: READERS_UNKNOWN_TEXT, allowedMentions: NO_MENTIONS });
  }

  async function handle(message: Message, c: Client, run: ConnectionScope, replay = false): Promise<void> {
    const botUserId = c.user?.id ?? "";
    const inbound = toInbound(message);
    if (unconfiguredGuild(inbound.guildId)) return;
    const accepted = () => run.backfill.seen(inbound.channelId, inbound.id);
    const staked = await stakedIn(run, inbound, botUserId);
    if (shouldMirror(inbound, botUserId, staked))
      mirrorEvent(c, toIngestEvent(inbound, botUserId, { handled: false, createdAt: Date.now() }));
    const routed = routeMessage(inbound, { id: botUserId, name: c.user?.username ?? "" }, cfg.guildIds);
    const prompted = routed !== null && (routed.target !== "thread" || !routed.unprompted);
    if (!routed || (!prompted && (!staked || replay))) {
      accepted();
      return;
    }
    const classified = await run.classifyUser(inbound.authorId, inbound.authorName);
    if (!classified) {
      if (prompted) await noticeReadersUnknown(message, accepted);
      return;
    }
    const actor = inbound.authorIsBot && !classified.isBot ? { ...classified, isBot: true } : classified;
    if (actor.isExternalGuest) {
      accepted();
      return;
    }
    const common = {
      actor,
      text: await withReplyContext(message, routed.text, botUserId),
      redeliveryKey: `discord:${message.id}`,
      ...(actor.isBot ? { botActor: true } : {}),
    };
    if (routed.target === "dm") {
      if (message.channel.type !== ChannelType.DM) return;
      accepted();
      const { attachments, notes } = await ingestAttachments(inbound.attachments, core);
      await runDiscordTurn({
        core,
        channel: replyChannel(message.channel),
        mode: "stream",
        inFlightRuns,
        mayPost: allowDmStream,
        onReact: reactHandler(run, { channelId: message.channelId, messageId: message.id }),
        body: {
          ...common,
          ...(attachments.length ? { attachments } : {}),
          ...(notes.length ? { inboundNotes: notes } : {}),
          ...dmTurnBody(message.channelId),
          triggerTs: message.id,
          entryTs: message.id,
          liveActor: true,
        },
      });
      return;
    }
    const scopeChannel = scopeChannelId(message.channel);
    const readers = await run.readersOf(scopeChannel);
    if (!readers.ok && readers.retry) {
      if (prompted) await noticeReadersUnknown(message, accepted);
      return;
    }
    accepted();
    const thread =
      routed.target === "new-thread"
        ? await message.startThread({ name: threadName(routed.title) })
        : (message.channel as AnyThreadChannel);
    const audience = readers.ok ? audienceWith(readers.readers, actor) : [actor, UNKNOWN_READER];
    const ack = prompted ? createDiscordAck(run.sender, { channelId: message.channelId, messageId: message.id }) : null;
    try {
      await runThreadTurn(c, run, {
        thread,
        scopeChannelId: scopeChannel,
        audience,
        common,
        attachmentRefs: inbound.attachments,
        history: {
          before: message.id,
          channelId: routed.target === "new-thread" ? scopeChannel : thread.id,
          threadId: routed.target === "new-thread" ? null : thread.id,
        },
        trigger: prompted
          ? { triggerTs: message.id, entryTs: message.id, liveActor: true }
          : { unprompted: true, entryTs: message.id, ...(actor.isBot ? {} : { liveActor: true }) },
        reactTarget: { channelId: message.channelId, messageId: message.id },
      });
    } finally {
      await ack?.settle();
    }
  }

  async function reactionThread(channels: DiscordChannels, message: Message): Promise<AnyThreadChannel | null> {
    if (message.channel.isThread()) return message.channel;
    if (!message.hasThread) return null;
    const thread = message.thread ?? (await channels.fetch(message.id));
    return thread?.isThread() ? thread : null;
  }

  function reactHandler(run: ConnectionScope, target: MessageTarget): ReactHandler {
    return async (names) => void (await applyDiscordReactions(run.sender, target, names));
  }

  function dmTurnBody(channelId: string): Pick<CoreTurnBody, "conversation" | "gatewayContext" | "deliveryTarget"> {
    const target = { kind: "dm" as const, channelId };
    return {
      conversation: conversationFor(target),
      gatewayContext: gatewayContextFor(target),
      deliveryTarget: deliveryTargetFor(target),
    };
  }

  async function runThreadTurn(
    c: Client,
    run: ConnectionScope,
    p: {
      thread: AnyThreadChannel;
      scopeChannelId: string;
      audience: ActorAssertion[];
      common: Pick<CoreTurnBody, "actor" | "text" | "redeliveryKey" | "botActor">;
      attachmentRefs: DiscordAttachmentRef[];
      history: { before?: string; channelId: string; threadId: string | null };
      trigger: Pick<CoreTurnBody, "triggerTs" | "entryTs" | "unprompted" | "liveActor">;
      reactTarget: MessageTarget;
      onNoReply?: () => Promise<void>;
    },
  ): Promise<void> {
    const botUserId = c.user?.id ?? "";
    run.stakes.mark(p.thread.id);
    const ownScope = p.scopeChannelId === p.thread.id;
    await run.channels.linked(p.thread);
    const channelName = ownScope ? p.thread.name : p.thread.parent?.name;
    const target = {
      kind: "thread" as const,
      threadId: p.thread.id,
      scopeChannelId: p.scopeChannelId,
      ...(channelName ? { channelName } : {}),
    };
    const { attachments, notes } = await ingestAttachments(p.attachmentRefs, core);
    const turnContext = await buildGuildTurnContext(
      { reader: run.historyReader, botUserId, botName: c.user?.username ?? "" },
      {
        ...(p.history.before ? { before: p.history.before } : {}),
        historyChannelId: p.history.channelId,
        threadId: p.history.threadId,
        triggerId: p.reactTarget.messageId,
        ...(target.channelName ? { channelName: target.channelName } : {}),
        audience: p.audience,
      },
    );
    await runDiscordTurn({
      core,
      channel: replyChannel(p.thread),
      mode: "spine",
      ownedRuns,
      mayPost: turnPostGate(run.readersOf, p.scopeChannelId),
      onReact: reactHandler(run, p.reactTarget),
      ...(p.onNoReply ? { onNoReply: p.onNoReply } : {}),
      body: {
        ...p.common,
        ...(attachments.length ? { attachments } : {}),
        ...(notes.length ? { inboundNotes: notes } : {}),
        conversation: conversationFor(target, p.audience),
        gatewayContext: gatewayContextFor(target),
        ...turnContext,
        deliveryTarget: deliveryTargetFor(target),
        ...p.trigger,
      },
    });
  }

  async function deleteIfUnused(thread: AnyThreadChannel): Promise<void> {
    const fetched = await thread.messages.fetch({ limit: THREAD_EMPTY_PROBE });
    if ([...fetched.values()].some((m) => m.type !== MessageType.ThreadStarterMessage)) return;
    if (sharedThreads.has(thread.id)) return;
    await thread.delete();
  }

  async function handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    added: boolean,
    c: Client,
    run: ConnectionScope,
  ): Promise<void> {
    const botUserId = c.user?.id ?? "";
    if (user.id === botUserId) return;
    const guildId = reaction.message.guildId;
    if (unconfiguredGuild(guildId)) return;
    const full = reaction.partial ? await reaction.fetch() : reaction;
    const message = full.message.partial ? await full.message.fetch() : full.message;
    const isDM = guildId === null;
    const onBotMessage = message.author.id === botUserId;
    const onFollowedRoot = !isDM && !onBotMessage && message.hasThread && (await run.stakes.has(message.id, botUserId));
    if (
      !shouldSurfaceReaction({
        itemType: REACTION_ITEM_MESSAGE,
        reactorId: user.id,
        botUserId,
        isDM,
        onBotMessage,
        onFollowedRoot,
      })
    )
      return;
    const flightKey = `${message.channelId}:${message.id}:${full.emoji.id ?? full.emoji.name}:${user.id}:${added ? "+" : "-"}`;
    if (reactionsInFlight.has(flightKey)) return;
    reactionsInFlight.add(flightKey);
    try {
      const reactor = user.partial ? await user.fetch() : user;
      const reactorName = displayNameOf(message.guild?.members.cache.get(reactor.id), reactor);
      const classified = await run.classifyUser(reactor.id, reactorName);
      if (!classified) return;
      const actor = reactor.bot && !classified.isBot ? { ...classified, isBot: true } : classified;
      if (actor.isExternalGuest) return;
      const inbound = toInbound(message);
      const reactions = added ? reactionTallies(message.reactions.cache.values()) : [];
      const text = buildReactionTurnText(DISCORD_SURFACE, {
        reactorName: actor.displayName || "Someone",
        emoji: emojiDisplayName(full.emoji),
        added,
        onBotMessage,
        ...(!onBotMessage && inbound.authorId !== reactor.id ? { authorName: inbound.authorName } : {}),
        ...(inbound.content ? { messageText: inbound.content } : {}),
        ...(reactions.length ? { reactions } : {}),
      });
      const common = { actor, text, ...(actor.isBot ? { botActor: true } : {}) };
      const reactTarget = { channelId: message.channelId, messageId: message.id };
      if (isDM) {
        if (message.channel.type !== ChannelType.DM) return;
        await runDiscordTurn({
          core,
          channel: replyChannel(message.channel),
          mode: "stream",
          inFlightRuns,
          mayPost: allowDmStream,
          onReact: reactHandler(run, reactTarget),
          body: { ...common, ...dmTurnBody(message.channelId), unprompted: true },
        });
        return;
      }
      const existing = await reactionThread(run.channels, message);
      if (!existing && !added) return;
      if (existing) sharedThreads.set(existing.id, true);
      const scopeChannel = existing ? scopeChannelId(existing) : message.channelId;
      const readers = await run.readersOf(scopeChannel);
      if (!readers.ok) return;
      const audience = audienceWith(readers.readers, actor);
      if (audience.some((a) => a.isExternalGuest)) return;
      let thread = existing;
      let created: AnyThreadChannel | null = null;
      if (!thread) {
        try {
          thread = await message.startThread({ name: threadName(inbound.content) });
          created = thread;
        } catch (err) {
          if ((err as { code?: unknown }).code !== RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) throw err;
          const raced = await run.channels.fetch(message.id);
          if (!raced?.isThread()) throw err;
          thread = raced;
          sharedThreads.set(thread.id, true);
        }
      }
      await runThreadTurn(c, run, {
        thread,
        scopeChannelId: scopeChannel,
        audience,
        common,
        attachmentRefs: [],
        history: { channelId: thread.id, threadId: thread.id },
        trigger: { unprompted: true },
        reactTarget,
        ...(created ? { onNoReply: () => deleteIfUnused(created!) } : {}),
      });
    } finally {
      reactionsInFlight.delete(flightKey);
    }
  }

  async function connect(): Promise<void> {
    if (stopped || client) return;
    let accepting = true;
    const inFlight = new Set<Promise<void>>();
    const c = clientFactory();
    client = c;
    const channels = createDiscordChannels(c, (threadId, parentId) => core.linkPrivateThread(threadId, parentId));

    const track = (work: Promise<void>, what: string): void => {
      const p = work.catch(swallowAs(what, undefined)).finally(() => inFlight.delete(p));
      inFlight.add(p);
    };
    let backfill: Backfill | null = null;
    const hydrator = createMemberHydrator({
      guildIds: cfg.guildIds,
      onAllReady: () => {
        if (!accepting) return;
        track(syncAll(), "discord: directory sync");
        if (backfill) track(backfill.run(), "discord: backfill");
      },
      fetchAll: async (g) => {
        const guild = await c.guilds.fetch(g);
        const before = new Set(guild.members.cache.keys());
        const fetched = await guild.members.fetch();
        for (const id of before) {
          if (!fetched.has(id)) guild.members.cache.delete(id);
        }
      },
      onError: (guildId, err) => reportFailureAs("discord: member hydration", undefined, `guild=${guildId}`)(err),
    });
    const mergedClassify = createMergedClassify({
      client: c,
      cfg,
      linkedInternal: (userId) => core.linkedInternal(userId),
      coreStatus: (userId) => core.coreStatus(userId),
    });
    const syncDirectory = createDirectorySync({
      ready: () => hydrator.allReady(),
      people: () => cachedPeople(c, cfg.guildIds),
      classify: mergedClassify,
      hold: (fn) => core.holdDirectorySync(fn),
      push: (members) => core.syncDirectory(members),
    });
    const lastMembersOk = new Map<string, number>();
    const syncRosters = createChannelRosterSync({
      compute: () =>
        computeDiscordRoster({
          channels,
          guildIds: cfg.guildIds,
          ready: (guildId) => hydrator.ready(guildId),
          botUserId: c.user?.id ?? "",
          lastMembersOk,
          classify: mergedClassify,
        }),
      hold: (fn) => core.holdDirectorySync(fn),
      push: (roster, syncedAt) => core.syncChannels(roster, syncedAt),
      lastMembersOk,
      retryMs: DISCORD_ROSTER_RETRY_MS,
    });
    const syncAll = syncDirectoryAndRosters(syncDirectory, syncRosters);
    const directorySweeper = createSweeper(syncAll, DISCORD_DIRECTORY_SYNC_MS, {
      label: "discord directory sync",
    });
    const classifyUser = createUserClassifier({
      client: c,
      cfg,
      hydrator,
      linkedInternal: (userId) => core.linkedInternal(userId),
      coreStatus: (userId) => core.coreStatus(userId),
    });
    const readersOf = async (channelId: string) =>
      channelReaders({
        viewers: await channelViewers(channels, channelId),
        guildIds: cfg.guildIds,
        ready: (guildId) => hydrator.ready(guildId),
        botUserId: c.user?.id ?? "",
        classify: (m) => mergedClassify(m.userId, m.displayName),
      });
    const stakes = createStakeTracker({ recent: createStakeHistory(channels) });
    const sender = createDiscordSender(c, channels);
    const guard = createDeliveryGuard({
      channelKind: createChannelKind(channels),
      readers: readersOf,
      classifyUser: (id) => classifyUser(id, id),
    });
    const dispatcher = createDiscordDispatcher({
      core,
      sender,
      guard,
      inFlightRuns,
      ownedRuns,
      renderCard: createCardRenderer(core, opts.webUiPublicUrl),
      recipientFor: (t) => recipientDiscordId(t, core.discordUserIdsFor),
    });

    const interact = createInteractionHandler({
      core,
      classifyUser: (id) => classifyUser(id, id),
      readersOf,
      continueTurn: async (body, hooks) => {
        const target = body.deliveryTarget;
        if (!target) return;
        let ch;
        try {
          ch = await sendable(channels, target);
        } catch (err) {
          return swallow("discord continue turn target", err);
        }
        const isDm = body.conversation.kind === "dm";
        if (!isDm && !body.conversation.channelRef) return;
        const mayPost = isDm ? allowDmStream : turnPostGate(readersOf, body.conversation.channelRef!);
        return runDiscordTurn({
          core,
          channel: replyChannel(ch),
          body,
          mode: "stream",
          inFlightRuns,
          ...hooks,
          mayPost,
        });
      },
    });

    const historyReader = createDiscordHistoryReader({
      channels,
      guildIds: cfg.guildIds,
      hydrator,
    });
    const fulfill = createContextFulfiller({
      core,
      reader: historyReader,
      botUserId: () => c.user?.id ?? "",
    });

    const lookupChannel = createChannelLookup({ core, reader: historyReader, guard });
    backfill = createBackfill<Message>({
      watermarks: () => core.channelWatermarks(),
      open: async (channelId) => {
        const ch = await channels.fetch(channelId);
        if (!ch || !ch.isTextBased() || ch.isDMBased()) return null;
        return {
          baseChannelId: scopeChannelId(ch),
          lastMessageId: ch.isThread() ? null : ch.lastMessageId,
          newest: async (limit) => [...(await ch.messages.fetch({ limit })).values()],
        };
      },
      dispatch: async (message) => {
        if (!message.hasThread)
          await handle(message, c, scope, true).catch(swallowAs("discord: backfill message", undefined));
      },
      noteGap: (channelId, note) => core.noteSurfaceHistoryGap(channelId, note),
    });
    const scope: ConnectionScope = {
      channels,
      classifyUser,
      readersOf,
      stakes,
      historyReader,
      sender,
      backfill,
    };

    let unsubscribeDeliveries: (() => void) | null = null;
    let unsubscribeContext: (() => void) | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    const drain = () => void dispatcher.drain().catch(swallowAs("discord: delivery drain", undefined));

    const detach = () => {
      accepting = false;
      hydrator.stop();
      track(directorySweeper.stop(), "discord: directory sweep drain");
      unsubscribeDeliveries?.();
      unsubscribeContext?.();
      if (pollTimer) clearInterval(pollTimer);
      return { client: c, inFlight };
    };
    detachClient = detach;

    c.on(Events.ShardReconnecting, () => hydrator.invalidate());
    c.on(Events.ShardDisconnect, () => hydrator.invalidate());
    c.on(Events.ShardReady, () => hydrator.hydrate());
    c.on(Events.ShardResume, () => hydrator.hydrate());
    c.once(Events.ClientReady, (ready) => {
      if (!accepting) return;
      console.log(`[qm] discord connected as @${ready.user.tag}`);
      for (const guildId of cfg.guildIds)
        track(linkActivePrivateThreads(c, channels, guildId), "discord: private thread links");
      directorySweeper.start();
      unsubscribeDeliveries = core.onDeliveryEnqueued(drain);
      pollTimer = setInterval(drain, DISCORD_DELIVERY_POLL_MS);
      drain();
      const contextRequestsInFlight = new Set<string>();
      const serviceContextRequest = (r: SurfaceContextRequest): void => {
        if (contextRequestsInFlight.has(r.id)) return;
        contextRequestsInFlight.add(r.id);
        track(
          (r.query.lookupChannel !== undefined ? lookupChannel : fulfill)(r).finally(() =>
            contextRequestsInFlight.delete(r.id),
          ),
          "discord: context request",
        );
      };

      unsubscribeContext = core.onContextRequest(serviceContextRequest);
      void core
        .pendingContextRequests()
        .then((pending) => {
          if (!accepting) return;
          for (const r of pending) serviceContextRequest(r);
        })
        .catch(swallowAs("discord: context request drain", undefined));
    });

    const rosterChanged = (guildId: string | null | undefined): void => {
      if (accepting && !unconfiguredGuild(guildId ?? null)) track(syncRosters(), "discord: channel roster sync");
    };
    c.on(Events.GuildMemberAdd, (m) => rosterChanged(m.guild.id));
    c.on(Events.GuildMemberRemove, (m) => rosterChanged(m.guild.id));
    c.on(Events.GuildMemberUpdate, (_old, m) => rosterChanged(m.guild.id));
    c.on(Events.GuildRoleCreate, (r) => rosterChanged(r.guild.id));
    c.on(Events.GuildRoleUpdate, (_old, r) => rosterChanged(r.guild.id));
    c.on(Events.GuildRoleDelete, (r) => rosterChanged(r.guild.id));
    c.on(Events.ChannelCreate, (ch) => rosterChanged(ch.guildId));
    c.on(Events.ChannelUpdate, (_old, ch) => rosterChanged("guildId" in ch ? ch.guildId : null));
    c.on(Events.ChannelDelete, (ch) => rosterChanged("guildId" in ch ? ch.guildId : null));
    c.on(Events.ThreadUpdate, (_old, t) => rosterChanged(t.guildId));
    c.on(Events.ThreadDelete, (t) => rosterChanged(t.guildId));
    c.on(Events.ThreadMembersUpdate, (_added, _removed, t) => rosterChanged(t.guildId));

    c.on(Events.ThreadCreate, (thread) => {
      rosterChanged(thread.guildId);
      if (accepting && !unconfiguredGuild(thread.guildId))
        track(
          channels.linked(thread).then(() => {}),
          "discord: private thread link",
        );
    });

    c.on(Events.InteractionCreate, (interaction) => {
      if (!accepting || !interaction.isButton()) return;
      track(
        interact({
          customId: interaction.customId,
          userId: interaction.user.id,
          defer: async () => void (await interaction.deferUpdate()),
          refuse: async (content) => void (await interaction.followUp({ content, flags: MessageFlags.Ephemeral })),
          settle: async (content) =>
            void (await interaction.editReply({ content, components: [], allowedMentions: NO_MENTIONS })),
          settleFinal: (content) => sender.edit(interaction.channelId, interaction.message.id, { content }),
        }),
        "discord: interaction",
      );
    });

    c.on(Events.MessageCreate, (message) => {
      if (accepting) track(handle(message, c, scope), "discord: message handler");
    });

    c.on(Events.MessageReactionAdd, (reaction, user) => {
      if (accepting) track(handleReaction(reaction, user, true, c, scope), "discord: reaction add");
    });

    c.on(Events.MessageReactionRemove, (reaction, user) => {
      if (accepting) track(handleReaction(reaction, user, false, c, scope), "discord: reaction remove");
    });

    c.on(Events.MessageUpdate, (_old, updated) => {
      if (accepting) track(handleEdit(updated, c, scope), "discord: message edit");
    });

    c.on(Events.MessageDelete, (deleted) => {
      if (accepting) track(handleDelete(deleted, c, scope), "discord: message delete");
    });

    c.on(Events.MessageBulkDelete, (deleted) => {
      if (!accepting) return;
      for (const message of deleted.values()) track(handleDelete(message, c, scope), "discord: message delete");
    });

    try {
      await c.login(cfg.botToken);
      loginFailures = 0;
    } catch (err) {
      reportFailureAs("discord plugin login", undefined)(err);
      detach();
      await c.destroy().catch(swallowAs("discord client cleanup", undefined));
      const isCurrent = client === c;
      if (isCurrent) {
        client = null;
        detachClient = null;
      }
      if (!stopped && !retryTimer && isCurrent) {
        loginFailures += 1;
        retryTimer = setTimeout(
          () => {
            retryTimer = null;
            void connect();
          },
          jitteredBackoffMs(loginFailures, { baseDelayMs: DISCORD_RETRY_BASE_MS, maxDelayMs: DISCORD_RETRY_MAX_MS }),
        );
      }
    }
  }

  return {
    async start() {
      stopped = false;
      if (client || retryTimer) return;
      await connect();
    },

    async stop() {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      loginFailures = 0;
      const detached = detachClient?.();
      client = null;
      detachClient = null;
      if (!detached) return stopPromise ?? Promise.resolve();
      const previousStop = stopPromise;
      const drainCurrent = async () => {
        if (detached.inFlight.size > 0) {
          let timer: NodeJS.Timeout;
          const timeoutPromise = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainTimeoutMs);
          });
          await Promise.race([Promise.allSettled(detached.inFlight).then(() => {}), timeoutPromise]).finally(() =>
            clearTimeout(timer),
          );
        }
        await detached.client.destroy();
      };
      let drainPromise: Promise<void> | null = null;
      drainPromise = (async () => {
        try {
          if (previousStop) {
            const [prevResult, currentResult] = await Promise.allSettled([previousStop, drainCurrent()]);
            if (prevResult.status === "rejected") throw prevResult.reason;
            if (currentResult.status === "rejected") throw currentResult.reason;
          } else {
            await drainCurrent();
          }
        } finally {
          if (stopPromise === drainPromise) {
            stopPromise = null;
          }
        }
      })();
      stopPromise = drainPromise;
      return stopPromise;
    },
  };
}
