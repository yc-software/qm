import { LRUCache } from "lru-cache";
import { WebClient } from "@slack/web-api";
import type { Loop, LoopItem } from "./types.ts";
import { isObj, type ConnectorTokenSource } from "./sources/adapter.ts";
import { isResolved } from "./ledger-view.ts";
import { INBOX_PRECHECK_QUERIES, inboxItemNeedsRepair, inboxSource } from "./inbox-loop.ts";
import { gmailThreadOf } from "./sources/gmail.ts";
import { slackConversationOf } from "./sources/slack.ts";
import { gmailApi } from "../connectors/gmail-api.ts";
import { normalizeSlackApiUrl } from "../slack/config.ts";
import { slackErrorCode } from "../slack/payloads.ts";
import { errMessage } from "../util/errors.ts";

type InboxQuietVerdict = { quiet: true } | { quiet: false; reason: string };

export type InboxQuietCheck = (loop: Loop, items: LoopItem[]) => Promise<InboxQuietVerdict>;

type SlackReader = Pick<WebClient, "apiCall">;

interface QuietCheckDeps {
  tokens: ConnectorTokenSource;
  fetchImpl?: typeof fetch;
  slackClient?: (token: string) => SlackReader;
  slackApiUrl?: string;
}

const OVERLAP_MS = 5 * 60 * 1000;
const GMAIL_PAGE = 500;
const SLACK_PAGE = 100;
const SEARCH_WIDEN_MS = 2 * 24 * 60 * 60 * 1000;
const ACCOUNT_TYPES = ["personal", undefined, "company"] as const;
const UNREADABLE = new Set(["channel_not_found", "thread_not_found", "not_in_channel"]);

class Overflow extends Error {}

const run = (reason: string): InboxQuietVerdict => ({ quiet: false, reason });

async function connectedTokens(tokens: ConnectorTokenSource, host: string, owner: string): Promise<string[]> {
  const found: string[] = [];
  for (const accountType of ACCOUNT_TYPES) {
    const token = await tokens.connectorAccessToken(host, owner, accountType);
    if (token && !found.includes(token)) found.push(token);
  }
  return found;
}

async function gmailNews(token: string, fetchImpl: typeof fetch, cutoff: number, threads: Set<string>) {
  const api = gmailApi(token, fetchImpl);
  const after = `after:${Math.floor(cutoff / 1000)} -in:drafts`;
  const list = async (q: string) => {
    const page = await api<{ messages?: Array<{ threadId: string }>; nextPageToken?: string }>(
      `messages?maxResults=${GMAIL_PAGE}&q=${encodeURIComponent(q)}`,
    );
    if (page.nextPageToken) throw new Overflow(`more than ${GMAIL_PAGE} Gmail messages since the last pass`);
    return page.messages ?? [];
  };
  if ((await list(after)).some((message) => threads.has(message.threadId)))
    return "new message on a tracked Gmail thread";
  const { sendAs = [] } = await api<{ sendAs?: Array<{ sendAsEmail?: string }> }>("settings/sendAs");
  const addressed = ["me", ...sendAs.flatMap((alias) => (alias.sendAsEmail ? [alias.sendAsEmail] : []))]
    .flatMap((address) => [`to:${address}`, `cc:${address}`])
    .join(" ");
  if ((await list(`${INBOX_PRECHECK_QUERIES.gmail.addressed} {${addressed}} ${after}`)).length)
    return "new inbound Gmail message addressed to the user";
  return null;
}

interface SlackMessage {
  ts?: string;
  user?: string;
  channel?: { id?: string };
  permalink?: string;
}

interface SlackConversation {
  channelId: string;
  threadTs?: string;
}

const slackMs = (ts: string | undefined) => (ts ? Number(ts) * 1000 : NaN);

function threadOf(match: SlackMessage): string | undefined {
  try {
    return new URL(match.permalink ?? "").searchParams.get("thread_ts") ?? undefined;
  } catch {
    return undefined;
  }
}

export function createInboxQuietCheck(deps: QuietCheckDeps): InboxQuietCheck {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const bots = new LRUCache<string, boolean>({ max: 5000, ttl: 24 * 60 * 60 * 1000 });

  const slackClient =
    deps.slackClient ??
    ((token: string) =>
      new WebClient(token, {
        slackApiUrl: normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api"),
        retryConfig: { retries: 2 },
        attachOriginalToWebAPIRequestError: false,
        timeout: 10_000,
      }));

  async function slack(token: string, method: string, params: Record<string, string>) {
    const body: unknown = await slackClient(token).apiCall(method, params);
    return isObj(body) ? body : {};
  }

  async function search(token: string, query: string, cutoff: number): Promise<SlackMessage[]> {
    const body = await slack(token, "search.messages", {
      query,
      sort: "timestamp",
      sort_dir: "desc",
      count: String(SLACK_PAGE),
    });
    const matches = isObj(body.messages) && Array.isArray(body.messages.matches) ? body.messages.matches : [];
    const fresh = (matches as SlackMessage[]).filter((match) => !(slackMs(match.ts) <= cutoff));
    if (fresh.length === SLACK_PAGE) throw new Overflow(`more than ${SLACK_PAGE} Slack messages since the last pass`);
    return fresh;
  }

  async function isBot(token: string, team: string, user: string): Promise<boolean> {
    const key = `${team}:${user}`;
    const cached = bots.get(key);
    if (cached !== undefined) return cached;
    const body = await slack(token, "users.info", { user });
    const bot = isObj(body.user) && (body.user.is_bot === true || body.user.is_app_user === true);
    bots.set(key, bot);
    return bot;
  }

  async function slackNews(token: string, cutoff: number, tracked: SlackConversation[]) {
    const auth = await slack(token, "auth.test", {});
    const self = typeof auth.user_id === "string" ? auth.user_id : "";
    const team = typeof auth.team_id === "string" ? auth.team_id : "";
    if (!self || !team) throw new Error("Slack auth.test returned no user");
    const after = `after:${new Date(cutoff - SEARCH_WIDEN_MS).toISOString().slice(0, 10)}`;
    const tracks = (match: SlackMessage) =>
      tracked.some(
        (c) =>
          c.channelId === match.channel?.id &&
          (!c.threadTs || c.threadTs === threadOf(match) || c.threadTs === match.ts),
      );
    for (const waiting of INBOX_PRECHECK_QUERIES.slack.waiting) {
      const query = `${waiting.replace("USER", self)} ${after}`;
      for (const match of await search(token, query, cutoff)) {
        if (match.user === self) continue;
        if (tracks(match)) return "new Slack message in a tracked conversation";
        if (!match.user || !(await isBot(token, team, match.user))) return "new Slack message for the user";
      }
    }
    if (
      tracked.length &&
      (await search(token, `${INBOX_PRECHECK_QUERIES.slack.ownReplies} ${after}`, cutoff)).some(tracks)
    )
      return "the user replied in a tracked Slack conversation";
    return null;
  }

  async function slackThreadNews(tokens: string[], cutoff: number, threads: SlackConversation[]) {
    const oldest = (cutoff / 1000).toFixed(6);
    for (const thread of threads) {
      for (const token of tokens) {
        try {
          const body = await slack(token, "conversations.replies", {
            channel: thread.channelId,
            ts: thread.threadTs!,
            oldest,
          });
          const messages = Array.isArray(body.messages) ? (body.messages as SlackMessage[]) : [];
          if (messages.some((message) => slackMs(message.ts) > cutoff)) return "new reply in a tracked Slack thread";
          break;
        } catch (error) {
          if (!UNREADABLE.has(slackErrorCode(error) ?? "")) throw error;
        }
      }
    }
    return null;
  }

  async function check(source: "gmail" | "slack", loop: Loop, open: LoopItem[], cutoff: number) {
    if (source === "gmail") {
      const tokens = await connectedTokens(deps.tokens, "gmail.googleapis.com", loop.owner);
      if (!tokens.length) return run("Gmail not connected");
      const threads = new Set<string>();
      for (const item of open) {
        const thread = gmailThreadOf(item);
        if (!thread) return run("an open item has no Gmail thread");
        threads.add(thread);
      }
      for (const token of tokens) {
        const news = await gmailNews(token, fetchImpl, cutoff, threads);
        if (news) return run(news);
      }
      return { quiet: true } as const;
    }
    const tokens = await connectedTokens(deps.tokens, "slack.com", loop.owner);
    if (!tokens.length) return run("Slack not connected");
    const tracked: SlackConversation[] = [];
    for (const item of open) {
      const conversation = slackConversationOf(item);
      if (!conversation) return run("an open item has no Slack conversation");
      tracked.push(conversation);
    }
    for (const token of tokens) {
      const news = await slackNews(token, cutoff, tracked);
      if (news) return run(news);
    }
    const news = await slackThreadNews(
      tokens,
      cutoff,
      tracked.filter((conversation) => conversation.threadTs),
    );
    return news ? run(news) : ({ quiet: true } as const);
  }

  return async (loop, items) => {
    const source = inboxSource(loop);
    if (source !== "gmail" && source !== "slack") return run(`unsupported inbox source ${source ?? "none"}`);
    if (!loop.lastScanAt) return run("no previous clean pass");
    const open = items.filter((item) => !isResolved(item));
    if (open.some((item) => item.source !== source || inboxItemNeedsRepair(item, source)))
      return run("an open item needs repair");
    try {
      return await check(source, loop, open, loop.lastScanAt - OVERLAP_MS);
    } catch (error) {
      if (error instanceof Overflow) return run(error.message);
      const code = slackErrorCode(error);
      console.warn(
        "%s",
        `[loops] inbox pre-check for ${loop.id} failed open: ${errMessage(error)}${code ? ` (${code})` : ""}`,
      );
      return run(`pre-check failed: ${errMessage(error)}`);
    }
  };
}
