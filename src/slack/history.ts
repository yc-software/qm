import { slackMessageToIngestEvent } from "./mirror.ts";
import { messageWithForwardedContent } from "./forwards.ts";
import type { SlackContextSource } from "./config.ts";
import { decodeSlackEntities } from "./lib.ts";
import { slackHistoryRateLimitMessage } from "./history-rate-limit.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { CachedMessage } from "../surface-cache/types.ts";
import type { BotIdentity } from "./directory.ts";
import type { SlackHistoryMessage } from "./payloads.ts";
import { parseMessageList } from "./payloads.ts";
import { swallow } from "../util/errors.ts";

interface SlackHistoryPage {
  raw: SlackHistoryMessage[];
  hasMore: boolean;
  expansionFailures?: number;
  truncatedExpansions?: number;
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
            return {
              page: parseMessageList(await historyClient.conversations.replies({ channel, ts: m.ts, limit: 200 })),
              failed: false,
            };
          } catch {
            return { page: { messages: [] as SlackHistoryMessage[], hasMore: false }, failed: true };
          }
        }),
      );
      const byTs = new Map<string, SlackHistoryMessage>();
      for (const m of [...raw, ...expanded.flatMap((result) => result.page.messages)]) if (m.ts) byTs.set(m.ts, m);
      return {
        raw: [...byTs.values()],
        hasMore: page.hasMore,
        expansionFailures: expanded.filter((result) => result.failed).length,
        truncatedExpansions: expanded.filter((result) => result.page.hasMore).length,
      };
    }
    return { raw, hasMore: page.hasMore };
  }

  async function mirrorHistory(
    channel: string,
    threadTs?: string,
    before?: string,
    expandThreads = false,
  ): Promise<CachedMessage[]> {
    const read = deps.core.readSurfaceMessages!;
    const options = { limit: 200, noFallback: true, ...(before ? { before } : {}) };
    if (threadTs) {
      const [parents, replies] = await Promise.all([
        read(channel, { at: threadTs, noFallback: true, ...(before ? { before } : {}) }),
        read(channel, { ...options, sub: threadTs }),
      ]);
      return [...parents, ...replies.slice(-(200 - parents.length))];
    }
    const roots = await read(channel, { ...options, channelHistory: true });
    if (!expandThreads) return roots;
    const parents = roots.filter((m) => (m.replyCount ?? 0) > 0).slice(-5);
    const expanded = await Promise.all(parents.map((m) => mirrorHistory(channel, m.ts)));
    return [...new Map([...roots, ...expanded.flat()].map((m) => [m.ts, m])).values()];
  }

  async function compareShadow(
    live: SlackHistoryPage,
    channel: string,
    threadTs?: string,
    before?: string,
    expandThreads = false,
  ): Promise<void> {
    if (!deps.core.readSurfaceMessages) return;
    try {
      const rows = await mirrorHistory(channel, threadTs, before, expandThreads);
      const timestamps = new Set(rows.map((m) => m.ts));
      const liveTimestamps = new Set(live.raw.flatMap((m) => (m.ts ? [m.ts] : [])));
      const ids = [...liveTimestamps];
      const storedRows: CachedMessage[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        storedRows.push(
          ...(await deps.core.readSurfaceMessages(channel, {
            timestamps: ids.slice(i, i + 500),
            limit: 500,
            noFallback: true,
            includeDeleted: true,
          })),
        );
      }
      const byTs = new Map(storedRows.map((m) => [m.ts, m]));
      let textMismatches = 0;
      let staleEditedMessages = 0;
      let threadParentMismatches = 0;
      let fileMismatches = 0;
      let matchingMessages = 0;
      let storedMessages = 0;
      for (const message of live.raw) {
        const stored = message.ts ? byTs.get(message.ts) : undefined;
        if (!stored || stored.deleted) continue;
        storedMessages++;
        const content = messageWithForwardedContent(message);
        const textMatches = stored.text === decodeSlackEntities(content.text);
        const parentMatches =
          stored.sub === (message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined);
        const files = (values: Array<{ id?: string; name?: string; mimetype?: string }>) =>
          JSON.stringify(
            values
              .filter((f) => f.id)
              .map((f) => [f.id, f.name ?? null, f.mimetype ?? null])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          );
        const filesMatch = files(content.files) === files((stored.files ?? []).map((f) => ({ ...f, id: f.fileId })));
        const stale = Math.round(Number(message.edited?.ts) * 1000) > (stored.editedAt ?? 0);
        if (!textMatches) textMismatches++;
        if (!parentMatches) threadParentMismatches++;
        if (!filesMatch) fileMismatches++;
        if (stale) staleEditedMessages++;
        if (textMatches && parentMatches && filesMatch && !stale && timestamps.has(stored.ts)) matchingMessages++;
      }
      console.info(
        JSON.stringify({
          event: "slack_mirror_shadow",
          version: 2,
          thread: Boolean(threadTs),
          expandThreads,
          conversationKind: channel.startsWith("D") ? "dm" : "channel_or_group",
          staleEditedMessages,
          liveMessages: liveTimestamps.size,
          mirroredMessages: timestamps.size,
          storedMessages,
          matchingMessages,
          textMismatches,
          threadParentMismatches,
          fileMismatches,
          liveMessagesMissingFromStorage: ids.filter((ts) => !byTs.has(ts) || byTs.get(ts)!.deleted).length,
          liveMessagesMissingFromMirror: ids.filter((ts) => !timestamps.has(ts)).length,
          mirrorMessagesOutsideLiveWindow: [...timestamps].filter((ts) => !liveTimestamps.has(ts)).length,
          missingThreadParent: Boolean(threadTs && !timestamps.has(threadTs)),
          liveHasMore: live.hasMore,
          liveExpansionFailures: live.expansionFailures ?? 0,
          liveTruncatedExpansions: live.truncatedExpansions ?? 0,
          liveComplete: !live.hasMore && !live.expansionFailures && !live.truncatedExpansions,
        }),
      );
    } catch {
      console.info(
        JSON.stringify({ event: "slack_mirror_shadow", version: 2, outcome: "read_failed", thread: Boolean(threadTs) }),
      );
    }
  }

  let shadowPending = false;
  return async (client, channel, threadTs, before, expandThreads) => {
    if (deps.source !== "mirror") {
      const live = await liveHistory(client, channel, threadTs, before, expandThreads);
      if (deps.source === "shadow" && !shadowPending) {
        shadowPending = true;
        void compareShadow(structuredClone(live), channel, threadTs, before, expandThreads).finally(() => {
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
        const rows = await mirrorHistory(channel, threadTs, before, expandThreads);
        mirrored = rows
          .filter((m) => !m.deleted && (!before || m.ts < before))
          .map((m) => ({
            ts: m.ts,
            ...(m.subtype !== undefined ? { subtype: m.subtype } : {}),
            text: m.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
            ...(m.mentionsSelf ? { mentionsSelf: true } : {}),
            ...(m.sub ? { thread_ts: m.sub } : {}),
            ...(m.self || m.authorId ? { user: m.self ? deps.ids.botUserId : m.authorId } : {}),
            ...(m.authorName ? { username: m.authorName } : {}),
            ...(m.bot ? { bot_id: m.botId ?? (m.self ? deps.ids.ownBotId : "mirrored-bot") } : {}),
            ...(m.files?.length
              ? {
                  files: m.files.map((f) => ({
                    id: f.fileId,
                    name: f.name,
                    title: f.title,
                    size: f.size,
                    mimetype: f.mimetype,
                  })),
                }
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
              .map((m) => slackMessageToIngestEvent({ ...m, channel }, deps.ids, { handled: true })),
          )
          .catch((error) => swallow("slack: history mirror ingest", error));
      }
      if (deps.core.readSurfaceMessages && page.messages.length) {
        const stored = await deps.core.readSurfaceMessages(channel, {
          timestamps: page.messages.flatMap((m) => (m.ts ? [m.ts] : [])),
          limit: 500,
          includeDeleted: true,
          noFallback: true,
        });
        for (const row of stored) if (row.deleted) deleted.add(row.ts);
      }
      const byTs = new Map<string, SlackHistoryMessage>();
      for (const message of [...mirrored, ...page.messages])
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
