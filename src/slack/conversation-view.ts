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
  botIdentityArgs,
  decodeSlackEntities,
  recentWindow,
} from "./lib.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { SlackConversationKind } from "./messaging.ts";
import { slackBotName, slackCustomBotName, type SlackHistoryMessage } from "./payloads.ts";
import { slackMessageContent } from "./message-content.ts";
import { isBotAuthored, isOwnSlackMessage, slackFileName } from "./message-gating.ts";
import { mentionedUserIds } from "./mrkdwn.ts";

export const RECENT_HISTORY_LIMIT = 200;
export const RECENT_THREAD_LIMIT = 200;
export const MAX_NAME_LOOKUPS = 10;
const RECENT_KEEP_SUBTYPES = new Set(["file_share", "bot_message", "thread_broadcast"]);

export function reactionTallies(raw: unknown): ReactionTally[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any) => ({ name: String(r?.name ?? ""), count: Number(r?.count) || 0 }))
    .filter((r) => r.name && r.count > 0);
}

export interface SlackPeople {
  names: Map<string, string>;
  principals: Map<string, string>;
}

export interface ConversationSerializer {
  shapeRecentMessages(
    client: any,
    raw: SlackHistoryMessage[],
    triggerTs: string,
    people: SlackPeople,
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
      isPrivate?: boolean;
      kind?: SlackConversationKind;
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
  ): Promise<{ view: ConversationView; threadFiles?: SlackFile[] }>;
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
    return isOwnSlackMessage(m, ids.botUserId, ids.ownBotId);
  }

  function messageAuthorName(m: SlackHistoryMessage, people: SlackPeople, botNameById: Map<string, string>): string {
    if (m.user && people.principals.has(m.user)) return people.names.get(m.user) ?? m.user;
    const botName = slackBotName(m);
    if (botName) return botName;
    if (m.user) return people.names.get(m.user) ?? m.user;
    if (m.bot_id) return botNameById.get(m.bot_id) ?? "someone";
    return "someone";
  }

  async function resolveMissingPeople(
    client: any,
    messages: SlackHistoryMessage[],
    people: SlackPeople,
    botNameById: Map<string, string>,
  ): Promise<void> {
    if (ids.botUserId && ids.botHandle && !people.names.has(ids.botUserId))
      people.names.set(ids.botUserId, ids.botHandle);
    const needUsers = new Set<string>();
    const needBots = new Set<string>();
    for (const m of messages) {
      if (isSelfMessage(m)) continue;
      if (m.user && !people.principals.has(m.user)) needUsers.add(m.user);
      else if (!m.user && m.bot_id && !botNameById.has(m.bot_id)) needBots.add(m.bot_id);
    }
    for (const m of messages)
      for (const id of mentionedUserIds(String(m.text ?? ""))) if (!people.names.has(id)) needUsers.add(id);
    await Promise.all([
      ...[...needUsers].map(async (id) => {
        const { actor, ok } = await directory.classifyUserCached(client, id);
        if (actor.displayName && !people.names.has(id)) people.names.set(id, actor.displayName);
        if (ok && !actor.isBot && actor.externalId) people.principals.set(id, actor.externalId);
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
    people: SlackPeople,
  ): Promise<RecentMessage[]> {
    const kept = raw.filter(isConversationMessage).sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return 0;
    });
    const botNameById = new Map<string, string>();
    await resolveMissingPeople(client, kept, people, botNameById);
    return kept.map((m) => {
      const content = slackMessageContent(m);
      const self = isSelfMessage(m);
      const principalId = m.user ? people.principals.get(m.user) : undefined;
      return {
        ts: m.ts,
        name: self
          ? (slackCustomBotName(m, botIdentityArgs().username) ?? "")
          : messageAuthorName(m, people, botNameById),
        ...(m.user || m.bot_id ? { authorId: String(m.user || m.bot_id) } : {}),
        ...(principalId ? { principalId } : {}),
        text: decodeSlackEntities(content.text.trim()),
        ...(m.ts === triggerTs ? { isTrigger: true } : {}),
        ...(isBotAuthored(m) ? { isBot: true } : {}),
        ...(self ? { isSelf: true } : {}),
        ...(m.thread_ts && String(m.thread_ts) !== m.ts ? { parentTs: String(m.thread_ts) } : {}),
        ...(reactionTallies(m.reactions).length ? { reactions: reactionTallies(m.reactions) } : {}),
        ...(content.files.length ? { files: content.files.map((f) => slackFileName(f)) } : {}),
      };
    });
  }

  function unansweredThreadFiles(
    raw: SlackHistoryMessage[],
    inc: { threadTs?: string; ts: string; userId?: string },
  ): SlackFile[] {
    if (!inc.threadTs) return [];
    const thread = raw
      .filter(isConversationMessage)
      .filter((m) => m.ts < inc.ts && (m.ts === inc.threadTs || String(m.thread_ts ?? "") === inc.threadTs))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    return thread
      .slice(thread.findLastIndex(isSelfMessage) + 1)
      .filter((m) => m.ts === inc.threadTs || (inc.userId && m.user === inc.userId))
      .flatMap((m) => slackMessageContent(m).files.map((f) => (f.user || !m.user ? f : { ...f, user: m.user })));
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
      isPrivate?: boolean;
      kind?: SlackConversationKind;
      slackIdsByPrincipal?: ReadonlyMap<string, string>;
    },
  ): Promise<{ view: ConversationView; threadFiles?: SlackFile[] }> {
    const empty: ConversationView = {
      channel: { kind: ctx.kind ?? inc.kind },
      messages: [],
      here: inc.threadTs ? { kind: "thread", youOpenedIt: false } : { kind: "top-level" },
    };
    if (ctx.audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled())) return { view: empty };

    const people: SlackPeople = { names: new Map(), principals: new Map() };
    for (const a of ctx.audience) {
      const slackId = ctx.slackIdsByPrincipal?.get(a.externalId);
      if (slackId && !a.isBot) people.principals.set(slackId, a.externalId);
      if (!a.displayName) continue;
      people.names.set(a.externalId, a.displayName);
      if (slackId) people.names.set(slackId, a.displayName);
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
    const messages = recentWindow(await shapeRecentMessages(client, raw, inc.ts, people), RECENT_MESSAGE_WINDOW);

    let here: ConversationView["here"];
    if (inc.threadTs) {
      const root = raw.find((m: any) => m.ts === inc.threadTs);
      const youOpenedIt = Boolean(root && isSelfMessage(root));
      here = {
        kind: "thread",
        youOpenedIt,
        ...(youOpenedIt && root?.text ? { openerText: decodeSlackEntities(String(root.text).trim()) } : {}),
      };
    } else {
      here = { kind: "top-level" };
    }

    const view: ConversationView = {
      channel: {
        kind: ctx.kind ?? inc.kind,
        ...(ctx.isPrivate !== undefined ? { isPrivate: ctx.isPrivate } : {}),
      },
      messages,
      here,
      nameById: people.names,
      ...("note" in page && page.note ? { contextNote: page.note } : {}),
    };
    const threadFiles = unansweredThreadFiles(raw, inc);
    return { view, ...(threadFiles.length ? { threadFiles } : {}) };
  }

  return { shapeRecentMessages, serializeSlackConversation, recentMessageWindow: RECENT_MESSAGE_WINDOW };
}
