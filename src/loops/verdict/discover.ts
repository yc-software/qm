import type { IngestEntryInput } from "../item-ledger.ts";
import type { Loop, LoopSourcePayload } from "../types.ts";
import { isObj } from "../sources/adapter.ts";
import { slackConversationRef } from "../sources/slack.ts";
import type { SourceClients } from "./fetch.ts";

const SCAN_OVERLAP_MS = 30 * 60 * 1000;
const FIRST_SCAN_MS = 3 * 24 * 60 * 60 * 1000;
const SLACK_SEARCH_COUNT = 100;
const GMAIL_PAGE = 100;

export type Discoverer = (loop: Loop, since: number) => Promise<IngestEntryInput[]>;

export function scanSince(loop: Pick<Loop, "lastScanAt">, now = Date.now()): number {
  return loop.lastScanAt ? loop.lastScanAt - SCAN_OVERLAP_MS : now - FIRST_SCAN_MS;
}

function threadTsOf(match: Record<string, unknown>): string | undefined {
  if (typeof match.thread_ts === "string") return match.thread_ts;
  if (typeof match.permalink !== "string") return undefined;
  try {
    return new URL(match.permalink).searchParams.get("thread_ts") ?? undefined;
  } catch {
    return undefined;
  }
}

export function createDiscoverer(clients: SourceClients): Discoverer {
  async function slack(loop: Loop, since: number): Promise<IngestEntryInput[]> {
    const token = await clients.slackToken(loop.owner);
    if (!token) return [];
    const identity = await clients.slackIdentity(loop.owner, token);
    const after = new Date(since).toISOString().slice(0, 10);
    const found = new Map<string, IngestEntryInput>();
    for (const query of [`with:me -from:me after:${after}`, `<@${identity.userId}> after:${after}`]) {
      for (let page = 1; ; page++) {
        const body = await clients.slackCall(loop.owner, token, "search.messages", {
          query,
          sort: "timestamp",
          sort_dir: "desc",
          count: String(SLACK_SEARCH_COUNT),
          page: String(page),
        });
        const matches = isObj(body.messages) && Array.isArray(body.messages.matches) ? body.messages.matches : [];
        let olderThanWindow = false;
        for (const match of matches.filter(isObj)) {
          if (typeof match.ts !== "string" || match.user === identity.userId) continue;
          const at = Math.round(Number(match.ts) * 1000);
          if (at <= since) {
            olderThanWindow = true;
            continue;
          }
          const channel = isObj(match.channel) ? match.channel : {};
          if (typeof channel.id !== "string") continue;
          const info = await clients.slackChannel(loop.owner, token, channel.id);
          const threadTs = threadTsOf(match);
          const key = slackConversationRef(channel.id, match.ts, threadTs, info.direct);
          if (found.has(key)) continue;
          const anchor = threadTs ?? (info.direct ? undefined : match.ts);
          const payload: LoopSourcePayload = {
            title: info.name ? `#${info.name}` : "Slack conversation",
            slack: {
              channelId: channel.id,
              ts: match.ts,
              ...(anchor ? { threadTs: anchor } : {}),
              isDirectMessage: info.direct,
              ...(typeof match.user === "string" ? { userId: match.user } : {}),
              ...(info.name ? { channelLabel: `#${info.name}` } : {}),
            },
          };
          found.set(key, { loopId: loop.id, dedupeKey: key, source: "slack", sourcePayload: payload, sourceAt: at });
        }
        const paging = isObj(body.messages) && isObj(body.messages.paging) ? body.messages.paging : {};
        const pages = typeof paging.pages === "number" ? paging.pages : 1;
        if (olderThanWindow || page >= pages) break;
      }
    }
    return [...found.values()];
  }

  async function gmail(loop: Loop, since: number): Promise<IngestEntryInput[]> {
    const token = await clients.gmailToken(loop.owner);
    if (!token) return [];
    const query = `in:inbox -from:me after:${Math.floor(since / 1000)}`;
    const entries: IngestEntryInput[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, maxResults: String(GMAIL_PAGE) });
      if (pageToken) params.set("pageToken", pageToken);
      const body = await clients.gmailRead<{ threads?: Array<{ id?: string }>; nextPageToken?: string }>(
        loop.owner,
        token,
        `threads?${params}`,
      );
      for (const thread of body.threads ?? []) {
        if (typeof thread.id !== "string") continue;
        entries.push({
          loopId: loop.id,
          dedupeKey: thread.id,
          source: "gmail",
          sourcePayload: { title: "Email thread", gmail: { threadId: thread.id } },
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return entries;
  }

  return async (loop, since) => {
    const source = loop.sources?.[0];
    if (source === "slack") return slack(loop, since);
    if (source === "gmail") return gmail(loop, since);
    return [];
  };
}
