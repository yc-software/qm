import { decodeSlackEntities, mentionsBot } from "./lib.ts";
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
) => Promise<SlackHistoryPage>;

const MIRROR_CONTEXT_NOTE =
  "Context comes from stored Slack events. Earlier messages, missed events, reactions, and attachment details may be absent; this is not a complete Slack history.";

export function createSlackHistoryReader(deps: {
  core: SlackCoreClient;
  ids: BotIdentity;
  managed?: boolean;
  setupUrl?: string;
  historyClient?: { conversations: { history(args: any): Promise<unknown>; replies(args: any): Promise<unknown> } };
}): SlackHistoryReader {
  return async (client, channel, threadTs, before) => {
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
