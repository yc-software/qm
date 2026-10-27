import { escapeSlackText } from "./mrkdwn.ts";
import { isOwnStatusCard } from "./message-gating.ts";
import { slackMessageToIngestEvent } from "./mirror.ts";
import { SHARED_SLACK_HISTORY_LIMIT, slackHistoryRateLimitMessage } from "./history-rate-limit.ts";
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
  live?: boolean,
) => Promise<SlackHistoryPage>;

const MIRROR_CONTEXT_NOTE =
  "Context comes from stored Slack events. Earlier messages, missed events, reactions, and attachment details may be absent; this is not a complete Slack history.";

export function createSlackHistoryReader(deps: {
  core: SlackCoreClient;
  ids: BotIdentity;
  managed?: boolean;
  historyLimit?: number;
  setupUrl?: string;
  historyClient?: { conversations: { history(args: any): Promise<unknown>; replies(args: any): Promise<unknown> } };
}): SlackHistoryReader {
  const limit = deps.managed ? SHARED_SLACK_HISTORY_LIMIT : (deps.historyLimit ?? 200);
  async function liveHistory(
    client: any,
    channel: string,
    threadTs?: string,
    before?: string,
    expandThreads = false,
  ): Promise<SlackHistoryPage> {
    const historyClient = deps.historyClient ?? client;
    const paging = { channel, limit, ...(before ? { latest: before, inclusive: false } : {}) };
    const page = parseMessageList(
      threadTs
        ? await historyClient.conversations.replies({ ...paging, ts: threadTs })
        : await historyClient.conversations.history(paging),
    );
    page.messages = page.messages.filter((m) => !isOwnStatusCard(m, deps.ids.botUserId, deps.ids.ownBotId));
    const raw = threadTs ? page.messages : page.messages.slice().reverse();
    if (!threadTs && expandThreads) {
      const parents = raw.filter((m) => m.ts && Number(m.reply_count) > 0).slice(-5);
      const expanded = await Promise.all(
        parents.map(async (m) => {
          try {
            return {
              page: parseMessageList(await historyClient.conversations.replies({ channel, ts: m.ts, limit })),
              failed: false,
            };
          } catch {
            return { page: { messages: [] as SlackHistoryMessage[], hasMore: false }, failed: true };
          }
        }),
      );
      const byTs = new Map<string, SlackHistoryMessage>();
      for (const m of [...raw, ...expanded.flatMap((result) => result.page.messages)])
        if (m.ts && !isOwnStatusCard(m, deps.ids.botUserId, deps.ids.ownBotId)) byTs.set(m.ts, m);
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
    pageLimit = 200,
  ): Promise<{ rows: CachedMessage[]; hasMore: boolean; truncatedExpansions?: number }> {
    const read = deps.core.readSurfaceMessages!;
    const options = { limit: pageLimit + 1, noFallback: true, ...(before ? { before } : {}) };
    if (threadTs) {
      const [parents, replies] = await Promise.all([
        read(channel, { at: threadTs, noFallback: true, ...(before ? { before } : {}) }),
        read(channel, { ...options, sub: threadTs, oldestFirst: true }),
      ]);
      const rows = [...parents, ...replies];
      return { rows: rows.slice(0, pageLimit), hasMore: rows.length > pageLimit };
    }
    const rootPage = await read(channel, { ...options, channelHistory: true });
    const roots = rootPage.slice(-pageLimit);
    const hasMore = rootPage.length > pageLimit;
    if (!expandThreads) return { rows: roots, hasMore };
    const parents = roots.filter((m) => (m.replyCount ?? 0) > 0).slice(-5);
    const expanded = await Promise.all(parents.map((m) => mirrorHistory(channel, m.ts, undefined, false, pageLimit)));
    return {
      rows: [...new Map([...roots, ...expanded.flatMap((page) => page.rows)].map((m) => [m.ts, m])).values()],
      hasMore,
      truncatedExpansions: expanded.filter((page) => page.hasMore).length,
    };
  }

  async function remember(channel: string, messages: SlackHistoryMessage[]): Promise<void> {
    if (!messages.length || !deps.core.rememberSurfaceHistory) return;
    await deps.core
      .rememberSurfaceHistory(
        messages
          .filter((m) => m.ts)
          .map((m) => slackMessageToIngestEvent({ ...m, channel }, deps.ids, { handled: true })),
      )
      .catch((error) => swallow("slack: history mirror ingest", error));
  }

  const backfilled = new Set<string>();
  return async (client, channel, threadTs, before, expandThreads, live) => {
    if (live) {
      const page = await liveHistory(client, channel, threadTs, before, expandThreads);
      if (threadTs && page.hasMore)
        throw new Error("Live Slack thread exceeds the history limit; its replies could not be read completely.");
      return page;
    }
    const historyClient = deps.historyClient ?? client;
    const key = threadTs ? `${channel}:${threadTs}` : channel;
    let mirrored: SlackHistoryMessage[] = [];
    let mirrorResult: SlackHistoryPage | undefined;
    const deleted = new Set<string>();
    if (deps.core.readSurfaceMessages) {
      try {
        const mirrorPage = await mirrorHistory(channel, threadTs, before, expandThreads);
        const rows = mirrorPage.rows;
        mirrored = rows
          .filter((m) => !m.deleted && (!before || m.ts < before))
          .map((m) => ({
            ts: m.ts,
            ...(m.subtype !== undefined ? { subtype: m.subtype } : {}),
            text: escapeSlackText(m.text),
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
          mirrorResult = {
            raw: mirrored,
            hasMore: mirrorPage.hasMore,
            ...(mirrorPage.truncatedExpansions !== undefined
              ? { truncatedExpansions: mirrorPage.truncatedExpansions }
              : {}),
            note: MIRROR_CONTEXT_NOTE,
          };
          if (before) return mirrorResult;
        }
      } catch (error) {
        swallow("slack: mirror context read", error);
      }
    }
    if (!before && backfilled.has(key))
      return mirrorResult ?? { raw: mirrored, hasMore: true, note: MIRROR_CONTEXT_NOTE };
    try {
      if (!before) backfilled.add(key);
      const paging = {
        channel,
        limit: mirrorResult ? Math.min(limit, SHARED_SLACK_HISTORY_LIMIT) : limit,
        ...(before ? { latest: before, inclusive: false } : {}),
      };
      const page = parseMessageList(
        threadTs
          ? await historyClient.conversations.replies({ ...paging, ts: threadTs })
          : await historyClient.conversations.history(paging),
      );
      page.messages = page.messages.filter((m) => !isOwnStatusCard(m, deps.ids.botUserId, deps.ids.ownBotId));
      await remember(channel, page.messages);
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
      if (!before && slackHistoryRateLimitMessage(error) && deps.core.noteSurfaceHistoryGap)
        await deps.core
          .noteSurfaceHistoryGap(
            channel,
            `Slack rate-limited the initial history pull for ${threadTs ? `thread ${threadTs} in ` : ""}this channel, so messages from before QM joined were not loaded.`,
          )
          .catch((noteError) => swallow("slack: history gap memory note", noteError));
      if (!mirrored.length) throw error;
      swallow("slack: incomplete mirror history fallback", error);
      if (mirrorResult)
        return {
          ...mirrorResult,
          note: [MIRROR_CONTEXT_NOTE, slackHistoryRateLimitMessage(error, deps)].filter(Boolean).join(" "),
        };
      return {
        raw: mirrored,
        hasMore: true,
        note: [MIRROR_CONTEXT_NOTE, slackHistoryRateLimitMessage(error, deps)].filter(Boolean).join(" "),
      };
    }
  };
}
