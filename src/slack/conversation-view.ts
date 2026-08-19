import { swallow } from "../util/errors.ts";
import {
  type ActorAssertion,
  type ConversationView,
  type ReactionTally,
  type RecentMessage,
  type SlackFile,
  MAX_RECENT_MESSAGES,
  MAX_TOP_LEVEL_CONTEXT_AGE_S,
  collectEarlierThreadFiles,
  decodeSlackEntities,
  isOversize,
  recentWindow,
} from "./lib.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { SlackConversationKind } from "./messaging.ts";

export const RECENT_HISTORY_LIMIT = 200;
export const RECENT_THREAD_LIMIT = 200;
const MAX_EXPANDED_THREADS = 5;
const EXPANDED_THREAD_REPLY_LIMIT = RECENT_THREAD_LIMIT;
export const MAX_NAME_LOOKUPS = 10;
const RECENT_KEEP_SUBTYPES = new Set(["file_share", "bot_message", "thread_broadcast"]);
const MEMBERS_SHOW_MAX = 40;

export const slackFileName = (f: SlackFile): string => f.name || f.title || f.id || "file";

export function reactionTallies(raw: unknown): ReactionTally[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any) => ({ name: String(r?.name ?? ""), count: Number(r?.count) || 0 }))
    .filter((r) => r.name && r.count > 0);
}

export interface ConversationSerializer {
  shapeRecentMessages(
    client: any,
    raw: any[],
    triggerTs: string,
    nameById: Map<string, string>,
  ): Promise<RecentMessage[]>;
  serializeSlackConversation(
    client: any,
    inc: { kind: "dm" | "channel"; channel: string; threadTs?: string; ts: string; files: SlackFile[] },
    ctx: {
      audience: ActorAssertion[];
      channelName?: string;
      isPrivate?: boolean;
      kind?: SlackConversationKind;
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
  ): Promise<{ view: ConversationView; earlierFiles: SlackFile[] }>;
  recentMessageWindow: number;
}

export function createConversationSerializer(deps: {
  ids: BotIdentity;
  directory: Directory;
  externalParticipantsEnabled(): Promise<boolean>;
  recentMessages?: number;
}): ConversationSerializer {
  const { ids, directory, externalParticipantsEnabled } = deps;
  const RECENT_MESSAGE_WINDOW = deps.recentMessages
    ? Math.min(RECENT_THREAD_LIMIT, Math.floor(deps.recentMessages))
    : MAX_RECENT_MESSAGES;

  function isConversationMessage(m: any): boolean {
    return Boolean(m.ts && !(m.subtype && !RECENT_KEEP_SUBTYPES.has(m.subtype)));
  }

  function isSelfMessage(m: any): boolean {
    return Boolean((m.user && m.user === ids.botUserId) || (ids.ownBotId && m.bot_id === ids.ownBotId));
  }

  function messageAuthorName(m: any, nameById: Map<string, string>, botNameById: Map<string, string>): string {
    if (m.bot_profile?.name) return String(m.bot_profile.name);
    if (m.username) return String(m.username);
    if (m.user) return nameById.get(m.user) ?? m.user;
    if (m.bot_id) return botNameById.get(m.bot_id) ?? "someone";
    return "someone";
  }

  async function resolveMissingAuthorNames(
    client: any,
    messages: any[],
    nameById: Map<string, string>,
    botNameById: Map<string, string>,
  ): Promise<void> {
    const needUsers = new Set<string>();
    const needBots = new Set<string>();
    for (const m of messages) {
      if (m.bot_profile?.name || m.username) continue;
      if (m.user && m.user !== ids.botUserId && !nameById.has(m.user)) needUsers.add(m.user);
      else if (!m.user && m.bot_id && m.bot_id !== ids.ownBotId && !botNameById.has(m.bot_id)) needBots.add(m.bot_id);
    }
    await Promise.all([
      ...[...needUsers].slice(0, MAX_NAME_LOOKUPS).map(async (id) => {
        const dn = (await directory.classifyUserCached(client, id)).actor.displayName;
        if (dn) nameById.set(id, dn);
      }),
      ...[...needBots].slice(0, MAX_NAME_LOOKUPS).map(async (id) => {
        try {
          const name = (await client.bots.info({ bot: id })).bot?.name;
          if (name) botNameById.set(id, String(name));
        } catch (e) {
          swallow("slack: bots.info", e);
        }
      }),
    ]);
  }

  async function fetchRawConversation(client: any, channel: string, threadTs: string | undefined): Promise<any[]> {
    try {
      if (threadTs) {
        return (
          (await client.conversations.replies({ channel, ts: threadTs, limit: RECENT_THREAD_LIMIT })).messages ?? []
        );
      }
      const history = ((await client.conversations.history({ channel, limit: RECENT_HISTORY_LIMIT })).messages ?? [])
        .slice()
        .reverse();
      const threadParents = history.filter((m: any) => m.ts && Number(m.reply_count) > 0).slice(-MAX_EXPANDED_THREADS);
      const expanded = await Promise.all(
        threadParents.map(async (p: any) => {
          try {
            return (
              (await client.conversations.replies({ channel, ts: p.ts, limit: EXPANDED_THREAD_REPLY_LIMIT }))
                .messages ?? []
            );
          } catch {
            return [];
          }
        }),
      );
      const byTs = new Map<string, any>();
      for (const m of [...history, ...expanded.flat()]) if (m?.ts) byTs.set(m.ts, m);
      return [...byTs.values()];
    } catch {
      return [];
    }
  }

  async function shapeRecentMessages(
    client: any,
    raw: any[],
    triggerTs: string,
    nameById: Map<string, string>,
  ): Promise<RecentMessage[]> {
    const kept = raw.filter(isConversationMessage).sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return 0;
    });
    const botNameById = new Map<string, string>();
    await resolveMissingAuthorNames(client, kept, nameById, botNameById);
    return kept.map((m) => ({
      ts: m.ts as string,
      name: messageAuthorName(m, nameById, botNameById),
      ...(m.user || m.bot_id ? { authorId: String(m.user || m.bot_id) } : {}),
      text: decodeSlackEntities(String(m.text ?? "").trim()),
      ...(m.ts === triggerTs ? { isTrigger: true } : {}),
      ...(m.bot_id ? { isBot: true } : {}),
      ...(isSelfMessage(m) ? { isSelf: true } : {}),
      ...(m.thread_ts && String(m.thread_ts) !== m.ts ? { parentTs: String(m.thread_ts) } : {}),
      ...(reactionTallies(m.reactions).length ? { reactions: reactionTallies(m.reactions) } : {}),
      ...(Array.isArray(m.files) && m.files.length
        ? { files: (m.files as any[]).map((f) => String(f?.name ?? f?.title ?? f?.id ?? "file")) }
        : {}),
    }));
  }

  async function serializeSlackConversation(
    client: any,
    inc: { kind: "dm" | "channel"; channel: string; threadTs?: string; ts: string; files: SlackFile[] },
    ctx: {
      audience: ActorAssertion[];
      channelName?: string;
      isPrivate?: boolean;
      kind?: SlackConversationKind;
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
  ): Promise<{ view: ConversationView; earlierFiles: SlackFile[] }> {
    const empty: ConversationView = {
      channel: { kind: ctx.kind ?? inc.kind },
      members: [],
      messages: [],
      here: inc.threadTs ? { kind: "thread", youOpenedIt: false } : { kind: "top-level" },
      files: [],
      omittedFiles: [],
    };
    if (ctx.audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled()))
      return { view: empty, earlierFiles: [] };

    const nameById = new Map<string, string>();
    for (const a of ctx.audience) {
      if (!a.displayName) continue;
      nameById.set(a.externalId, a.displayName);
      const slackId = ctx.slackIdsByPrincipal?.get(a.externalId);
      if (slackId) nameById.set(slackId, a.displayName);
    }
    const raw = await fetchRawConversation(client, inc.channel, inc.threadTs);
    const messages = recentWindow(
      await shapeRecentMessages(client, raw, inc.ts, nameById),
      RECENT_MESSAGE_WINDOW,
      inc.threadTs ? undefined : { triggerTs: inc.ts, maxAgeSeconds: MAX_TOP_LEVEL_CONTEXT_AGE_S },
    );
    const earlierFiles = collectEarlierThreadFiles(raw, {
      triggerTs: inc.ts,
      botUserId: ids.botUserId,
      ownBotId: ids.ownBotId,
      have: inc.files,
      inThread: Boolean(inc.threadTs),
    });

    const members =
      ctx.audience.length > 0 && ctx.audience.length <= MEMBERS_SHOW_MAX
        ? ctx.audience
            .filter((a) => a.displayName)
            .map((a) => ({
              id: a.externalId,
              name: a.displayName as string,
              ...(ctx.slackIdsByPrincipal?.get(a.externalId)
                ? { mentionId: ctx.slackIdsByPrincipal.get(a.externalId) }
                : {}),
              ...(a.externalId === ids.botUserId ? { isYou: true } : {}),
              ...(a.isBot ? { isBot: true } : {}),
            }))
        : [];

    let here: ConversationView["here"];
    if (inc.threadTs) {
      const root = raw.find((m: any) => m.ts === inc.threadTs);
      const youOpenedIt = Boolean(
        root && ((root.user && root.user === ids.botUserId) || (ids.ownBotId !== "" && root.bot_id === ids.ownBotId)),
      );
      const starterName = root && !youOpenedIt ? messageAuthorName(root, nameById, new Map()) : undefined;
      here = {
        kind: "thread",
        youOpenedIt,
        ...(starterName ? { starterName } : {}),
        ...(youOpenedIt && root?.text ? { openerText: decodeSlackEntities(String(root.text).trim()) } : {}),
      };
    } else {
      here = { kind: "top-level" };
    }

    const allFiles = [...inc.files, ...earlierFiles];
    const files = allFiles.filter((f) => !isOversize(f)).map((f) => ({ name: slackFileName(f) }));
    const omittedFiles = allFiles
      .filter((f) => isOversize(f))
      .map((f) => ({ name: slackFileName(f), reason: "too-big" as const }));

    const view: ConversationView = {
      channel: {
        ...(ctx.channelName ? { name: ctx.channelName } : {}),
        kind: ctx.kind ?? inc.kind,
        ...(ctx.isPrivate !== undefined ? { isPrivate: ctx.isPrivate } : {}),
      },
      members,
      messages,
      here,
      files,
      omittedFiles,
      nameById,
    };
    return { view, earlierFiles };
  }

  return { shapeRecentMessages, serializeSlackConversation, recentMessageWindow: RECENT_MESSAGE_WINDOW };
}
