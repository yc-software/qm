import type { DiscordCoreClient } from "../api/discord-core-client.ts";
import type { SurfaceContextRequest } from "../reach/reach.ts";
import { buildContextWindow, MAX_RECENT_MESSAGES, type RecentMessage } from "../surfaces/conversation.ts";
import { DISCORD_MESSAGE_IDS } from "../surfaces/message-ids.ts";
import type { ReactionTally } from "../surfaces/reaction-tally.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { snowflakeMs } from "../util/snowflake.ts";
import { utcMinute } from "../util/time.ts";
import { discordExternalId } from "./config.ts";
import { parseDiscordTarget, type DeliveryGuard } from "./deliveries.ts";

export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  text: string;
  threadTs?: string;
  reactions: ReactionTally[];
}

export interface DiscordThreadInfo {
  ownerId: string | null;
  starter: HistoryMessage | null;
}

export interface DiscordHistoryReader {
  recent(channelId: string, opts: { count: number; before?: string }): Promise<HistoryMessage[]>;
  thread(threadId: string): Promise<DiscordThreadInfo>;
  canView(channelId: string, userId: string): Promise<boolean | undefined>;
  find(query: string): Promise<Array<{ id: string; name: string; dm?: true }>>;
}

const DISCORD_READ_MAX = 100;
const discordTime = (id: string): string => utcMinute(snowflakeMs(id));
const NOT_VISIBLE = "You can't read that Discord channel.";
export const READERS_UNKNOWN = "I can't confirm who can read that Discord channel right now. Try again in a minute.";

export function createContextFulfiller(deps: {
  core: Pick<DiscordCoreClient, "fulfillContextRequest" | "discordUserIdsFor">;
  reader: Pick<DiscordHistoryReader, "recent" | "canView">;
  botUserId: () => string;
}): (request: SurfaceContextRequest) => Promise<void> {
  async function answer(q: SurfaceContextRequest["query"]) {
    if (q.openGroup) return { error: "Discord has no group DMs the bot can open." };
    if (q.searchAll || q.file || q.syncDirectory) return { error: "That lookup isn't available on Discord." };
    const target = q.conversationTarget ?? q.channelId;
    if (!target) return { error: "No Discord conversation to read." };
    const { channelId } = parseDiscordTarget(target);
    const viewers = q.viewer ? deps.core.discordUserIdsFor(q.viewer) : [];
    const visible = await Promise.all(viewers.map((id) => deps.reader.canView(channelId, id)));
    if (!visible.some(Boolean)) return { error: NOT_VISIBLE };
    const count = Math.max(1, Math.min(DISCORD_READ_MAX, q.count ?? MAX_RECENT_MESSAGES));
    const scan = q.match ? DISCORD_READ_MAX : count;
    const rows = await deps.reader.recent(channelId, { count: scan, ...(q.before ? { before: q.before } : {}) });
    const bot = deps.botUserId();
    const shaped: RecentMessage[] = rows.map((m) => ({
      ts: m.id,
      name: m.authorName,
      text: m.text,
      reactions: m.reactions,
      ...(m.authorId === bot ? { isSelf: true } : {}),
      ...(m.threadTs ? { parentTs: m.threadTs } : {}),
    }));
    const authorIdByTs = new Map(rows.map((m) => [m.id, discordExternalId(m.authorId)]));
    const window = buildContextWindow(shaped, {
      count,
      formatTs: discordTime,
      messageIds: DISCORD_MESSAGE_IDS,
      ...(q.match ? { match: q.match } : {}),
      scanHasMore: rows.length >= scan,
    });
    return {
      result: {
        ...window,
        messages: window.messages.map((m) => ({ ...m, authorId: authorIdByTs.get(m.ts) })),
      },
    };
  }
  return async (request) => {
    const outcome = await answer(request.query).catch((err: unknown) => ({ error: errMessage(err) }));
    await deps.core.fulfillContextRequest(request.id, outcome);
  };
}

export function createChannelLookup(deps: {
  core: Pick<DiscordCoreClient, "fulfillContextRequest" | "discordUserIdsFor">;
  reader: Pick<DiscordHistoryReader, "canView" | "find">;
  guard: DeliveryGuard;
}): (request: SurfaceContextRequest) => Promise<void> {
  async function answer(q: SurfaceContextRequest["query"], query: string) {
    const viewers = q.viewer ? deps.core.discordUserIdsFor(q.viewer) : [];
    const candidates = await deps.reader.find(query).catch(swallowAs("discord: channel find", null));
    if (!candidates) return { result: { messages: [], retry: true } };
    const judged = await Promise.all(
      candidates.map(async (m) => ({
        m,
        views: await Promise.all(viewers.map((v) => deps.reader.canView(m.id, v))),
      })),
    );
    const matches = judged.filter((j) => j.views.includes(true)).map((j) => j.m);
    if (matches.length === 0)
      return { result: { messages: [], ...(judged.some((j) => j.views.includes(undefined)) ? { retry: true } : {}) } };
    if (matches.length > 1) {
      const options = matches.map((m) => `#${m.name} (${m.id})`).join(", ");
      return { error: `"${query}" matches several Discord channels — pass an id: ${options}` };
    }
    const { id, name, dm } = matches[0]!;
    if (q.postable) {
      const verdict = await deps.guard.mayPost(id);
      if (!verdict.ok)
        return { error: verdict.retry ? READERS_UNKNOWN : `I can't post in #${name}: ${verdict.reason}.` };
    }
    return { result: { messages: [], channel: { channelId: id, name, ...(dm ? { dm } : {}) } } };
  }
  return async (request) => {
    const outcome = await answer(request.query, request.query.lookupChannel ?? "").catch((err: unknown) => ({
      error: errMessage(err),
    }));
    await deps.core.fulfillContextRequest(request.id, outcome);
  };
}
