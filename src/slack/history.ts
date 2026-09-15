import { messageWithForwardedContent } from "./forwards.ts";
import type { SlackContextSource } from "./config.ts";
import { decodeSlackEntities, mentionsBot, resolveMentionsInText } from "./lib.ts";
import { slackHistoryRateLimitMessage } from "./history-rate-limit.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { BotIdentity } from "./directory.ts";
import type { SlackHistoryMessage } from "./payloads.ts";
import { parseMessageList } from "./payloads.ts";
import { swallow } from "../util/errors.ts";

interface SlackHistoryPage {
  raw: SlackHistoryMessage[];
  hasMore: boolean;
  note?: string;
}

export type SlackHistoryReader = (
  client: any,
  channel: string,
  threadTs?: string,
  before?: string,
  expandThreads?: boolean,
) => Promise<SlackHistoryPage>;

const MIRROR_CONTEXT_NOTE =
  "Context comes from stored Slack events. Earlier messages, missed events, reactions, and attachment details may be absent; this is not a complete Slack history.";

export function createSlackHistoryReader(deps: {
  core: SlackCoreClient;
  source?: SlackContextSource;
  ids: BotIdentity;
  managed?: boolean;
  setupUrl?: string;
  historyClient?: { conversations: { history(args: any): Promise<unknown>; replies(args: any): Promise<unknown> } };
}): SlackHistoryReader {
  async function liveHistory(
    client: any,
    channel: string,
    threadTs?: string,
    before?: string,
    expandThreads = false,
  ): Promise<SlackHistoryPage> {
    const historyClient = deps.historyClient ?? client;
    const paging = { channel, limit: 200, ...(before ? { latest: before, inclusive: false } : {}) };
    const page = parseMessageList(
      threadTs
        ? await historyClient.conversations.replies({ ...paging, ts: threadTs })
        : await historyClient.conversations.history(paging),
    );
    const raw = threadTs ? page.messages : page.messages.slice().reverse();
    if (!threadTs && expandThreads) {
      const parents = raw.filter((m) => m.ts && Number(m.reply_count) > 0).slice(-5);
      const expanded = await Promise.all(
        parents.map(async (m) => {
          try {
            return parseMessageList(await historyClient.conversations.replies({ channel, ts: m.ts, limit: 200 }))
              .messages;
          } catch {
            return [];
          }
        }),
      );
      const byTs = new Map<string, SlackHistoryMessage>();
      for (const m of [...raw, ...expanded.flat()]) if (m.ts) byTs.set(m.ts, m);
      return { raw: [...byTs.values()], hasMore: page.hasMore };
    }
    return { raw, hasMore: page.hasMore };
  }

  async function compareShadow(
    live: SlackHistoryPage,
    channel: string,
    threadTs?: string,
    before?: string,
  ): Promise<void> {
    if (!deps.core.readSurfaceMessages) return;
    try {
      const options = { limit: 200, noFallback: true, ...(before ? { before } : {}) };
      const rows = threadTs
        ? (
            await Promise.all([
              deps.core.readSurfaceMessages(channel, { ...options, sub: threadTs }),
              deps.core.readSurfaceMessages(channel, { at: threadTs, noFallback: true }),
            ])
          ).flat()
        : await deps.core.readSurfaceMessages(channel, options);
      const timestamps = new Set(rows.filter((m) => !m.deleted && (!before || m.ts < before)).map((m) => m.ts));
      const liveTimestamps = new Set(live.raw.flatMap((m) => (m.ts ? [m.ts] : [])));
      const byTs = new Map(rows.map((m) => [m.ts, m]));
      let textMismatches = 0;
      let staleEditedMessages = 0;
      for (const message of live.raw) {
        const stored = message.ts ? byTs.get(message.ts) : undefined;
        if (!stored || stored.deleted) continue;
        const liveText = resolveMentionsInText(
          decodeSlackEntities(messageWithForwardedContent(message).text),
          (id) => stored.mentions?.[id],
        );
        if (stored.text !== liveText) textMismatches++;
        if (Number(message.edited?.ts) * 1000 > (stored.editedAt ?? 0)) staleEditedMessages++;
      }
      console.info(
        JSON.stringify({
          event: "slack_mirror_shadow",
          thread: Boolean(threadTs),
          conversationKind: channel.startsWith("D") ? "dm" : "channel_or_group",
          staleEditedMessages,
          liveMessages: liveTimestamps.size,
          mirroredMessages: timestamps.size,
          textMismatches,
          liveMessagesMissingFromMirror: [...liveTimestamps].filter((ts) => !timestamps.has(ts)).length,
          mirrorMessagesOutsideLiveWindow: [...timestamps].filter((ts) => !liveTimestamps.has(ts)).length,
          missingThreadParent: Boolean(threadTs && !timestamps.has(threadTs)),
          liveHasMore: live.hasMore,
        }),
      );
    } catch {
      console.info(JSON.stringify({ event: "slack_mirror_shadow", outcome: "read_failed", thread: Boolean(threadTs) }));
    }
  }

  let shadowPending = false;
  return async (client, channel, threadTs, before, expandThreads) => {
    if (deps.source !== "mirror") {
      const live = await liveHistory(client, channel, threadTs, before, expandThreads);
      if (deps.source === "shadow" && !shadowPending) {
        shadowPending = true;
        void compareShadow(live, channel, threadTs, before).finally(() => {
          shadowPending = false;
        });
      }
      return live;
    }
    const historyClient = deps.historyClient ?? client;
    let mirrored: SlackHistoryMessage[] = [];
    const deleted = new Set<string>();
    if (deps.core.readSurfaceMessages) {
      try {
        const options = { limit: 200, includeDeleted: true, ...(before ? { before } : {}) };
        const rows = threadTs
          ? (
              await Promise.all([
                deps.core.readSurfaceMessages(channel, { ...options, sub: threadTs }),
                deps.core.readSurfaceMessages(channel, { at: threadTs, includeDeleted: true }),
              ])
            ).flat()
          : await deps.core.readSurfaceMessages(channel, options);
        for (const row of rows) if (row.deleted) deleted.add(row.ts);
        mirrored = rows
          .filter((m) => !m.deleted && (!before || m.ts < before))
          .map((m) => ({
            ts: m.ts,
            text: m.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
            ...(m.mentionsSelf ? { mentionsSelf: true } : {}),
            ...(m.sub ? { thread_ts: m.sub } : {}),
            ...(m.self || m.authorId ? { user: m.self ? deps.ids.botUserId : m.authorId } : {}),
            ...(m.authorName ? { username: m.authorName } : {}),
            ...(m.bot ? { bot_id: m.self ? deps.ids.ownBotId : "mirrored-bot" } : {}),
            ...(m.files?.length
              ? { files: m.files.map((f) => ({ id: f.fileId, name: f.name, mimetype: f.mimetype })) }
              : {}),
          }));
        if (mirrored.length && (!threadTs || rows.some((m) => m.ts === threadTs) || before)) {
          return { raw: mirrored, hasMore: rows.length >= 200, note: MIRROR_CONTEXT_NOTE };
        }
      } catch (error) {
        swallow("slack: mirror context read", error);
      }
    }
    try {
      const paging = { channel, limit: 200, ...(before ? { latest: before, inclusive: false } : {}) };
      const page = parseMessageList(
        threadTs
          ? await historyClient.conversations.replies({ ...paging, ts: threadTs })
          : await historyClient.conversations.history(paging),
      );
      if (page.messages.length && deps.core.rememberSurfaceHistory) {
        await deps.core
          .rememberSurfaceHistory(
            page.messages
              .filter((m) => m.ts)
              .map((m) => ({
                container: channel,
                ts: m.ts!,
                ...(m.thread_ts && m.thread_ts !== m.ts ? { sub: m.thread_ts } : {}),
                ...(m.user ? { authorId: m.user } : {}),
                ...(m.username ? { authorName: m.username } : {}),
                text: decodeSlackEntities(String(m.text ?? "")),
                ...(mentionsBot(String(m.text ?? ""), deps.ids.botUserId) ? { mentionsSelf: true } : {}),
                ...(m.user === deps.ids.botUserId ? { self: true } : {}),
                ...(m.bot_id ? { bot: true } : {}),
                ...(Number(m.edited?.ts) > 0 ? { editedAt: Math.round(Number(m.edited!.ts) * 1000) } : {}),
                handled: true,
                ...(m.files?.length
                  ? {
                      files: m.files
                        .filter((f) => f.id)
                        .map((f) => ({ fileId: f.id!, name: f.name, mimetype: f.mimetype })),
                    }
                  : {}),
              })),
          )
          .catch((error) => swallow("slack: history mirror ingest", error));
      }
      const byTs = new Map<string, SlackHistoryMessage>();
      for (const message of [...page.messages, ...mirrored])
        if (message.ts && !deleted.has(message.ts)) byTs.set(message.ts, message);
      return {
        raw: [...byTs.values()],
        hasMore: page.hasMore,
        ...(page.hasMore ? { note: "Slack history is truncated; older messages may be absent." } : {}),
      };
    } catch (error) {
      if (!mirrored.length) throw error;
      swallow("slack: incomplete mirror history fallback", error);
      return {
        raw: mirrored,
        hasMore: true,
        note: [MIRROR_CONTEXT_NOTE, slackHistoryRateLimitMessage(error, deps)].filter(Boolean).join(" "),
      };
    }
  };
}
