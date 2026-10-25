import { slackHistoryRateLimitMessage } from "./history-rate-limit.ts";
import type { SlackHistoryReader } from "./history.ts";
import { swallow } from "../util/errors.ts";
import {
  type ActorAssertion,
  type ConversationView,
  type ReactionTally,
  type RecentMessage,
  type SlackFile,
  MAX_RECENT_MESSAGES,
  decodeSlackEntities,
  isOversize,
  recentWindow,
} from "./lib.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { SlackConversationKind } from "./messaging.ts";
import { type SlackHistoryMessage } from "./payloads.ts";
import { messageWithForwardedContent } from "./forwards.ts";

export const RECENT_HISTORY_LIMIT = 200;
export const RECENT_THREAD_LIMIT = 200;
export const MAX_NAME_LOOKUPS = 10;
const RECENT_KEEP_SUBTYPES = new Set(["file_share", "bot_message", "thread_broadcast"]);
const MEMBERS_SHOW_MAX = 40;

export const slackFileName = (f: SlackFile): string => f.name || f.title || f.id || "file";

function reactionTallies(
  raw: unknown,
  nameById: ReadonlyMap<string, string> = new Map(),
  botUserId?: string,
): ReactionTally[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any) => ({
      name: String(r?.name ?? ""),
      count: Number(r?.count) || 0,
      ...(Array.isArray(r?.users)
        ? {
            users: [
              ...new Set<string>(r.users.filter((id: unknown): id is string => typeof id === "string" && !!id)),
            ].map((id) => {
              const ts = r.timestamps?.[id];
              return {
                id,
                name: id === botUserId ? "you" : (nameById.get(id) ?? id),
                ...(id === botUserId ? { isSelf: true } : {}),
                ...(typeof ts === "string" && Number.isFinite(Number(ts)) && Number(ts) > 0 ? { ts } : {}),
              };
            }),
          }
        : {}),
    }))
    .filter((r) => r.name && r.count > 0);
}

export interface ConversationSerializer {
  shapeRecentMessages(
    client: any,
    raw: SlackHistoryMessage[],
    triggerTs: string,
    nameById: Map<string, string>,
  ): Promise<RecentMessage[]>;
  serializeSlackConversation(
    client: any,
    inc: {
      kind: "dm" | "channel";
      channel: string;
      threadTs?: string;
      ts: string;
      files: SlackFile[];
      rawText?: string;
      userId?: string;
    },
    ctx: {
      audience: ActorAssertion[];
      channelName?: string;
      isPrivate?: boolean;
      kind?: SlackConversationKind;
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
  ): Promise<{ view: ConversationView }>;
  recentMessageWindow: number;
}

export function createConversationSerializer(deps: {
  ids: BotIdentity;
  directory: Directory;
  externalParticipantsEnabled(): Promise<boolean>;
  recentMessages?: number;
  readHistory: SlackHistoryReader;
  historyRateLimitOptions?: { managed?: boolean; setupUrl?: string };
}): ConversationSerializer {
  const { ids, directory, externalParticipantsEnabled } = deps;
  const RECENT_MESSAGE_WINDOW = deps.recentMessages
    ? Math.min(RECENT_THREAD_LIMIT, Math.floor(deps.recentMessages))
    : MAX_RECENT_MESSAGES;

  function isConversationMessage(m: SlackHistoryMessage): m is SlackHistoryMessage & { ts: string } {
    return Boolean(m.ts && !(m.subtype && !RECENT_KEEP_SUBTYPES.has(m.subtype)));
  }

  function isSelfMessage(m: SlackHistoryMessage): boolean {
    return Boolean((m.user && m.user === ids.botUserId) || (ids.ownBotId && m.bot_id === ids.ownBotId));
  }

  function messageAuthorName(
    m: SlackHistoryMessage,
    nameById: Map<string, string>,
    botNameById: Map<string, string>,
  ): string {
    if (m.bot_profile?.name) return String(m.bot_profile.name);
    if (m.username) return String(m.username);
    if (m.user) return nameById.get(m.user) ?? m.user;
    if (m.bot_id) return botNameById.get(m.bot_id) ?? "someone";
    return "someone";
  }

  async function resolveMissingNames(
    client: any,
    messages: SlackHistoryMessage[],
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
    for (const m of messages) {
      for (const reaction of reactionTallies(m.reactions)) {
        for (const user of reaction.users ?? []) {
          if (user.id !== ids.botUserId && !nameById.has(user.id)) needUsers.add(user.id);
        }
      }
    }
    const snapshot = needUsers.size ? await directory.getUserSnapshot(client) : undefined;
    for (const id of needUsers) {
      const name = snapshot?.byId.get(id)?.actor.displayName;
      if (name) nameById.set(id, name);
    }
    await Promise.all([
      ...[...needUsers]
        .filter((id) => !nameById.has(id))
        .slice(0, MAX_NAME_LOOKUPS)
        .map(async (id) => {
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

  async function shapeRecentMessages(
    client: any,
    raw: SlackHistoryMessage[],
    triggerTs: string,
    nameById: Map<string, string>,
  ): Promise<RecentMessage[]> {
    const kept = raw.filter(isConversationMessage).sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return 0;
    });
    const botNameById = new Map<string, string>();
    await resolveMissingNames(client, kept, nameById, botNameById);
    return kept.map((m) => {
      const content = messageWithForwardedContent(m);
      const reactions = reactionTallies(m.reactions, nameById, ids.botUserId);
      return {
        ts: m.ts,
        name: messageAuthorName(m, nameById, botNameById),
        ...(m.user || m.bot_id ? { authorId: String(m.user || m.bot_id) } : {}),
        text: decodeSlackEntities(content.text.trim()),
        ...(m.ts === triggerTs ? { isTrigger: true } : {}),
        ...(m.bot_id ? { isBot: true } : {}),
        ...(isSelfMessage(m) ? { isSelf: true } : {}),
        ...(m.thread_ts && String(m.thread_ts) !== m.ts ? { parentTs: String(m.thread_ts) } : {}),
        ...(m.reactions !== undefined ? { reactions } : {}),
        ...(content.files.length ? { files: content.files.map((f) => slackFileName(f)) } : {}),
      };
    });
  }

  async function serializeSlackConversation(
    client: any,
    inc: {
      kind: "dm" | "channel";
      channel: string;
      threadTs?: string;
      ts: string;
      files: SlackFile[];
      rawText?: string;
      userId?: string;
    },
    ctx: {
      audience: ActorAssertion[];
      channelName?: string;
      isPrivate?: boolean;
      kind?: SlackConversationKind;
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
  ): Promise<{ view: ConversationView }> {
    const empty: ConversationView = {
      channel: { kind: ctx.kind ?? inc.kind },
      members: [],
      messages: [],
      here: inc.threadTs ? { kind: "thread", youOpenedIt: false } : { kind: "top-level" },
      files: [],
      omittedFiles: [],
    };
    if (ctx.audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled())) return { view: empty };

    const nameById = new Map<string, string>();
    for (const a of ctx.audience) {
      if (!a.displayName) continue;
      nameById.set(a.externalId, a.displayName);
      const slackId = ctx.slackIdsByPrincipal?.get(a.externalId);
      if (slackId) nameById.set(slackId, a.displayName);
    }
    const page = await deps.readHistory(client, inc.channel, inc.threadTs, undefined, true).catch((error) => {
      swallow("slack: conversation context", error);
      return {
        raw: [] as SlackHistoryMessage[],
        hasMore: true,
        note:
          slackHistoryRateLimitMessage(error, deps.historyRateLimitOptions) ??
          "Slack context could not be read; earlier messages may be missing.",
      };
    });
    const raw = page.raw;
    if (inc.rawText !== undefined && !raw.some((m) => m.ts === inc.ts))
      raw.push({ ts: inc.ts, text: inc.rawText, user: inc.userId, thread_ts: inc.threadTs, files: inc.files });
    const messages = recentWindow(await shapeRecentMessages(client, raw, inc.ts, nameById), RECENT_MESSAGE_WINDOW);

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

    const files = inc.files.filter((f) => !isOversize(f)).map((f) => ({ name: slackFileName(f) }));
    const omittedFiles = inc.files
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
      ...("note" in page && page.note ? { contextNote: page.note } : {}),
    };
    return { view };
  }

  return { shapeRecentMessages, serializeSlackConversation, recentMessageWindow: RECENT_MESSAGE_WINDOW };
}
