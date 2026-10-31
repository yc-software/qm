import {
  MAX_RECENT_MESSAGES,
  recentWindow,
  renderConversationView,
  type ConversationView,
  type RecentMessage,
} from "../surfaces/conversation.ts";
import { HANDOFF_INSTRUCTION, reactionDetectGuidance } from "../surfaces/instructions.ts";
import { DISCORD_MESSAGE_IDS } from "../surfaces/message-ids.ts";
import type { ActorAssertion, ConversationTurn, GatewayContext, OverheardMessage } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { DISCORD_SURFACE, discordUserIdOf } from "./config.ts";
import { type DiscordHistoryReader, type HistoryMessage } from "./context.ts";
import type { DiscordConversationTarget } from "./events.ts";

const HISTORY_UNREADABLE_NOTE = "Discord context could not be read; earlier messages may be missing.";

const REACTION_TARGET_INSTRUCTION =
  "Each message in the conversation above carries an id in brackets like `[~abc123]`. To react to one of those messages, " +
  "pass that exact id, including the leading `~`, as the react action's `ts`.";

const CONTEXT_FETCH_SLACK = 5;

const NICKNAME_MENTION = /<@!(\d+)>/g;

export interface DiscordTurnContext {
  conversationHeader?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardMessage[];
  detectContext?: string;
  detectOpener?: string;
}

export function gatewayContextFor(target: DiscordConversationTarget): GatewayContext {
  if (target.kind === "dm") {
    return {
      location: "a direct message with the user",
      details: { channel: target.channelId },
      reactionGuidance: reactionDetectGuidance(DISCORD_SURFACE),
    };
  }
  return {
    location: target.channelName ? `#${target.channelName}` : `channel ${target.scopeChannelId}`,
    details: {
      channel: target.scopeChannelId,
      ...(target.channelName ? { channel_name: `#${target.channelName}` } : {}),
      thread_id: target.threadId,
    },
    instructions: `${REACTION_TARGET_INSTRUCTION}\n\n${HANDOFF_INSTRUCTION}`,
    reactionGuidance: reactionDetectGuidance(DISCORD_SURFACE),
  };
}

function shape(m: HistoryMessage, botUserId: string, triggerId: string): RecentMessage {
  return {
    ts: m.id,
    name: m.authorName,
    authorId: m.authorId,
    text: m.text.replace(NICKNAME_MENTION, "<@$1>").trim(),
    ...(m.id === triggerId ? { isTrigger: true } : {}),
    ...(m.authorIsBot ? { isBot: true } : {}),
    ...(m.authorId === botUserId ? { isSelf: true } : {}),
  };
}

export async function buildGuildTurnContext(
  deps: { reader: Pick<DiscordHistoryReader, "recent" | "thread">; botUserId: string; botName: string },
  input: {
    triggerId: string;
    before?: string;
    historyChannelId: string;
    threadId: string | null;
    channelName?: string;
    audience: readonly ActorAssertion[];
  },
): Promise<DiscordTurnContext> {
  const { reader, botUserId, botName } = deps;
  if (input.audience.some((a) => a.isExternalGuest)) return {};
  let note: string | undefined;
  const history = await reader
    .recent(input.historyChannelId, {
      count: MAX_RECENT_MESSAGES + CONTEXT_FETCH_SLACK,
      ...(input.before ? { before: input.before } : {}),
    })
    .catch((err: unknown) => {
      swallow("discord: conversation context", err);
      note = HISTORY_UNREADABLE_NOTE;
      return [] as HistoryMessage[];
    });
  const info = input.threadId
    ? await reader.thread(input.threadId).catch((err: unknown) => {
        swallow("discord: thread info", err);
        note = HISTORY_UNREADABLE_NOTE;
        return { ownerId: null, starter: null };
      })
    : null;
  const starter = info?.starter && !history.some((m) => m.id === info.starter!.id) ? [info.starter] : [];
  const all = [...starter, ...history];

  const nameById = new Map<string, string>([[botUserId, botName]]);
  for (const m of all) nameById.set(m.authorId, m.authorName);
  for (const a of input.audience) {
    const id = discordUserIdOf(a.externalId);
    if (id && a.displayName) nameById.set(id, a.displayName);
  }

  const opening = input.threadId === null;
  const youOpenedIt = opening || info?.ownerId === botUserId;
  const starterMessage = info?.starter;
  const here: ConversationView["here"] = {
    kind: "thread",
    youOpenedIt,
    ...(starterMessage && !youOpenedIt ? { starterName: starterMessage.authorName } : {}),
    ...(starterMessage && youOpenedIt ? { openerText: starterMessage.text.trim() } : {}),
  };

  const view: ConversationView = {
    messageIds: DISCORD_MESSAGE_IDS,
    channel: { ...(input.channelName ? { name: input.channelName } : {}), kind: "channel" },
    messages: recentWindow(
      all.map((m) => shape(m, botUserId, input.triggerId)),
      DISCORD_MESSAGE_IDS,
      MAX_RECENT_MESSAGES,
    ),
    here,
    omittedFiles: [],
    nameById,
    ...(note ? { contextNote: note } : {}),
  };
  const rendered = renderConversationView(view);
  return {
    ...(rendered.header ? { conversationHeader: rendered.header } : {}),
    ...(rendered.priorTurns.length ? { priorTurns: rendered.priorTurns } : {}),
    ...(rendered.overheard.length ? { overheard: rendered.overheard } : {}),
    ...(rendered.detectContext ? { detectContext: rendered.detectContext } : {}),
    ...(rendered.detectOpener ? { detectOpener: rendered.detectOpener } : {}),
  };
}
