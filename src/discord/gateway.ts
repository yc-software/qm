import {
  ChannelType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Channel,
  type Client,
  type GuildMember,
  type Message,
} from "discord.js";
import type { ActorAssertion } from "../types.ts";
import type { DiscordPluginConfig } from "./config.ts";
import type { DirectoryPerson } from "./directory.ts";
import type { DiscordHistoryReader, DiscordThreadInfo, HistoryMessage } from "./context.ts";
import type { ChannelKind } from "./deliveries.ts";
import { attachmentRefs, withForwardedContent } from "./forwards.ts";
import type { DiscordInbound } from "./events.ts";
import type { MemberHydrator } from "./member-hydrator.ts";
import {
  classifyMember,
  type CoreStatusOf,
  mergeMemberships,
  type DiscordMemberFacts,
  type LinkedInternal,
} from "./members.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { SNOWFLAKE } from "../util/snowflake.ts";
import { DISCORD_MESSAGE_IDS } from "../surfaces/message-ids.ts";
import { DISCORD_AUDIENCE_CAP, type ChannelViewers } from "./readers.ts";
import { reactionTallies } from "./reactions.ts";
import type { StakeMessage } from "./thread-stake.ts";

const GONE_CODES: unknown[] = [RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.MissingAccess];
const isGone = (err: unknown): boolean =>
  GONE_CODES.includes((err as { code?: unknown }).code) || (err as { status?: unknown }).status === 404;
const STAKE_HISTORY_LIMIT = 100;
const AVATAR_SIZE = 64;
const VIEWER_SCAN_LIMIT = DISCORD_AUDIENCE_CAP + 2;

export function memberFacts(m: GuildMember): DiscordMemberFacts {
  return {
    userId: m.id,
    displayName: m.displayName,
    roleIds: [...m.roles.cache.keys()].filter((id) => id !== m.guild.id),
    isBot: m.user.bot,
    ...(m.pending ? { pending: true } : {}),
  };
}

const DM_CHANNEL_NAME = "direct message";

export function displayNameOf(
  member: { displayName: string } | null | undefined,
  user: { globalName: string | null; username: string },
): string {
  return member?.displayName ?? user.globalName ?? user.username;
}

export type ThreadLinker = (threadId: string, parentId: string) => Promise<void>;

export interface DiscordChannels {
  fetch(channelId: string): Promise<Channel | null>;
  cached(channelId: string): Promise<Channel | null>;
  unlinkedCache(): Iterable<Channel>;
  linked<T extends Channel>(ch: T): Promise<T>;
}

export function createDiscordChannels(client: Pick<Client, "channels">, link: ThreadLinker): DiscordChannels {
  const linked = async <T extends Channel>(ch: T): Promise<T> => {
    if (ch.type === ChannelType.PrivateThread && ch.parentId) await link(ch.id, ch.parentId);
    return ch;
  };
  return {
    linked,
    fetch: async (channelId) => {
      const ch = await client.channels.fetch(channelId);
      return ch && linked(ch);
    },
    cached: async (channelId) => {
      const ch = client.channels.cache.get(channelId);
      return ch ? linked(ch) : null;
    },
    unlinkedCache: () => client.channels.cache.values(),
  };
}

async function fetchIfPresent(channels: DiscordChannels, channelId: string): Promise<Channel | null> {
  try {
    return await channels.fetch(channelId);
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
}

function baseOf(ch: Channel | null) {
  const base = ch?.isThread() ? ch.parent : ch;
  return base && "guild" in base && "permissionsFor" in base ? base : null;
}

export function scopeChannelId(ch: {
  id: string;
  type: ChannelType;
  isThread(): boolean;
  parentId?: string | null;
}): string {
  if (ch.type === ChannelType.PrivateThread || !ch.isThread()) return ch.id;
  return ch.parentId ?? ch.id;
}

const CAN_VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;
const CAN_READ_HISTORY = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

export async function channelViewers(
  channels: DiscordChannels,
  channelId: string,
  limit = VIEWER_SCAN_LIMIT,
): Promise<ChannelViewers> {
  let ch;
  try {
    ch = await channels.cached(channelId);
  } catch (err) {
    swallow("discord: channel viewers lookup", err);
    return { ok: false, reason: "members_not_ready" };
  }
  const base = baseOf(ch);
  if (!base) return { ok: false, reason: "not_a_guild_channel" };
  let threadMembers: ReadonlySet<string> | null = null;
  if (ch?.type === ChannelType.PrivateThread) {
    try {
      threadMembers = new Set((await ch.members.fetch()).keys());
    } catch (err) {
      swallow("discord: private thread members", err);
      return { ok: false, reason: isGone(err) ? "not_a_guild_channel" : "members_not_ready" };
    }
  }
  const members: DiscordMemberFacts[] = [];
  for (const m of base.guild.members.cache.values()) {
    if (members.length >= limit) break;
    const perms = base.permissionsFor(m);
    if (!perms.has(CAN_VIEW_CHANNEL)) continue;
    if (!threadMembers || threadMembers.has(m.id) || perms.has(PermissionFlagsBits.ManageThreads))
      members.push({ ...memberFacts(m), ...(perms.has(CAN_READ_HISTORY) ? {} : { viewOnly: true as const }) });
  }
  return { ok: true, guildId: base.guild.id, members };
}

export function cachedPeople(client: Client, guildIds: ReadonlySet<string>): DirectoryPerson[] {
  const people = new Map<string, DirectoryPerson>();
  for (const guildId of guildIds) {
    for (const m of client.guilds.cache.get(guildId)?.members.cache.values() ?? []) {
      if (!m.user.bot && !people.has(m.id)) {
        people.set(m.id, { userId: m.id, avatarUrl: m.displayAvatarURL({ extension: "png", size: AVATAR_SIZE }) });
      }
    }
  }
  return [...people.values()];
}

export function createChannelKind(channels: DiscordChannels): (channelId: string) => Promise<ChannelKind | null> {
  return async (channelId) => {
    let ch;
    try {
      ch = await channels.fetch(channelId);
    } catch (err) {
      if ((err as { code?: unknown }).code === RESTJSONErrorCodes.UnknownChannel) return null;
      throw err;
    }
    if (!ch) return null;
    if (ch.type === ChannelType.DM) return { kind: "dm", recipientId: ch.recipientId };
    const base = ch.isThread() ? ch.parent : ch;
    if (!base || !("guild" in base)) return null;
    return { kind: "guild", baseChannelId: scopeChannelId(ch) };
  };
}

export function createMergedClassify(deps: {
  client: Client;
  cfg: DiscordPluginConfig;
  linkedInternal: LinkedInternal;
  coreStatus: CoreStatusOf;
}): (userId: string, fallbackName: string) => Promise<ActorAssertion> {
  return async (userId, fallbackName) => {
    const memberships = [...deps.cfg.guildIds]
      .map((g) => deps.client.guilds.cache.get(g)?.members.cache.get(userId))
      .filter((m): m is GuildMember => m !== undefined)
      .map(memberFacts);
    const displayName = memberships.map((m) => m.displayName).sort()[0] ?? fallbackName;
    return classifyMember(
      mergeMemberships(userId, displayName, memberships),
      deps.cfg,
      deps.linkedInternal,
      deps.coreStatus,
    );
  };
}

export function createUserClassifier(deps: {
  client: Client;
  cfg: DiscordPluginConfig;
  hydrator: Pick<MemberHydrator, "allReady">;
  linkedInternal: LinkedInternal;
  coreStatus: CoreStatusOf;
}): (userId: string, fallbackName: string) => Promise<ActorAssertion | null> {
  const merged = createMergedClassify(deps);
  return async (userId, fallbackName) => {
    const actor = await merged(userId, fallbackName);
    return actor.isExternalGuest && !deps.hydrator.allReady() ? null : actor;
  };
}

export function createStakeHistory(channels: DiscordChannels): (threadId: string) => Promise<StakeMessage[]> {
  return async (threadId) => {
    const ch = await channels.fetch(threadId);
    if (!ch?.isTextBased()) return [];
    const recent = await ch.messages.fetch({ limit: STAKE_HISTORY_LIMIT });
    return [...recent.values()].map((m) => ({ authorId: m.author.id, mentionedUserIds: [...m.mentions.users.keys()] }));
  };
}

export function toInbound(message: Message): DiscordInbound {
  const forwarded = withForwardedContent(message.content, message.messageSnapshots?.values() ?? []);
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    threadParentId: message.channel.isThread() ? message.channel.parentId : null,
    channelName: "name" in message.channel ? message.channel.name : null,
    authorId: message.author.id,
    authorName: displayNameOf(message.member, message.author),
    authorIsBot: message.author.bot,
    content: forwarded.text,
    mentionedUserIds: [...message.mentions.users.keys()],
    attachments: [...attachmentRefs(message.attachments), ...forwarded.attachments],
  };
}

function toHistoryMessage(m: Message, threadId: string | null): HistoryMessage {
  return {
    id: m.id,
    authorId: m.author.id,
    authorName: displayNameOf(m.member, m.author),
    authorIsBot: m.author.bot,
    text: withForwardedContent(m.content, m.messageSnapshots?.values() ?? []).text,
    reactions: reactionTallies(m.reactions.cache.values()),
    ...(threadId ? { threadTs: threadId } : {}),
  };
}

export function createDiscordHistoryReader(deps: {
  channels: DiscordChannels;
  guildIds: ReadonlySet<string>;
  hydrator: Pick<MemberHydrator, "ready">;
}): DiscordHistoryReader {
  return {
    async find(query: string) {
      const wanted = query.trim().replace(/^#/, "").toLowerCase();
      const inScope = (ch: Channel | null): ch is Channel & { name: string } =>
        ch !== null &&
        ch.isTextBased() &&
        "guildId" in ch &&
        "name" in ch &&
        deps.guildIds.has(ch.guildId) &&
        (ch.id === wanted || ch.name.toLowerCase() === wanted);
      const hits = [...deps.channels.unlinkedCache()].filter(inScope);
      const byId = hits.filter((ch) => ch.id === wanted);
      const fetched = byId.length === 0 && SNOWFLAKE.test(wanted) ? await fetchIfPresent(deps.channels, wanted) : null;
      if (fetched?.type === ChannelType.DM) return [{ id: fetched.id, name: DM_CHANNEL_NAME, dm: true as const }];
      const exact = inScope(fetched) ? [fetched] : byId;
      return Promise.all(
        (exact.length > 0 ? exact : hits).map(async (ch) => {
          await deps.channels.linked(ch);
          return { id: ch.id, name: ch.name };
        }),
      );
    },
    async recent(channelId: string, opts: { count: number; before?: string }): Promise<HistoryMessage[]> {
      const ch = await deps.channels.fetch(channelId);
      if (!ch || !ch.isTextBased()) throw new Error(`Discord channel ${channelId} isn't readable by the bot`);
      const fetched = await ch.messages.fetch({
        limit: opts.count,
        ...(opts.before ? { before: opts.before } : {}),
      });
      const threadId = ch.isThread() ? ch.id : null;
      return [...fetched.values()]
        .sort((a, b) => DISCORD_MESSAGE_IDS.compare(a.id, b.id))
        .map((m) => toHistoryMessage(m, threadId));
    },

    async thread(threadId: string): Promise<DiscordThreadInfo> {
      const ch = await deps.channels.fetch(threadId);
      if (!ch?.isThread()) return { ownerId: null, starter: null };
      const starter = await ch.fetchStarterMessage().catch(swallowAs("discord: starter message", null));
      return { ownerId: ch.ownerId, starter: starter ? toHistoryMessage(starter, ch.id) : null };
    },

    async canView(channelId: string, userId: string): Promise<boolean | undefined> {
      try {
        const ch = await fetchIfPresent(deps.channels, channelId);
        if (!ch) return false;
        if (ch.type === ChannelType.DM) {
          return ch.recipientId === userId;
        }
        const base = baseOf(ch);
        if (!base) return false;
        if (!deps.guildIds.has(base.guild.id)) return false;
        if (!deps.hydrator.ready(base.guild.id)) return undefined;
        const member = base.guild.members.cache.get(userId);
        if (!member) return false;
        const perms = base.permissionsFor(member);
        if (!perms.has(CAN_READ_HISTORY)) return false;
        if (ch.type === ChannelType.PrivateThread) {
          if (ch.members.cache.has(userId) || perms.has(PermissionFlagsBits.ManageThreads)) return true;
          await ch.members.fetch({ member: userId, cache: false });
        }
        return true;
      } catch (err) {
        swallow("discord: can view", err);
        return isGone(err) ? false : undefined;
      }
    },
  };
}
