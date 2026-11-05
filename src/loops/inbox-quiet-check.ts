import { LRUCache } from "lru-cache";
import type { Loop, LoopItem } from "./types.ts";
import { isObj, type ConnectorTokenSource } from "./sources/adapter.ts";
import { isResolved } from "./ledger-view.ts";
import { inboxSource } from "./inbox-loop.ts";
import { gmailApi } from "../connectors/gmail-api.ts";
import { normalizeSlackApiUrl } from "../slack/config.ts";
import { errMessage } from "../util/errors.ts";

// Before an inbox loop spends a model turn on its sync pass, prove with plain provider
// reads that nothing it would act on changed since the last clean pass. Doubt runs the turn.
export type InboxQuietVerdict = { quiet: true } | { quiet: false; reason: string };

export type InboxQuietCheck = (loop: Loop, items: LoopItem[]) => Promise<InboxQuietVerdict>;

interface QuietCheckDeps {
  tokens: ConnectorTokenSource;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
}

// Mail delivery and Slack's search index trail the clock by seconds to minutes.
const OVERLAP_MS = 5 * 60 * 1000;
// Largest page each API returns; a full page of news is too much to prove quiet.
const GMAIL_PAGE = 500;
const SLACK_PAGE = 100;
// The sync pass rereads these same conversations and waits out short rate limits too.
const SLACK_RETRIES = 3;
const MAX_RETRY_AFTER_S = 30;
// Slack's date filter is day-granular and exclusive; widen it and compare timestamps.
const SEARCH_SLACK_MS = 2 * 24 * 60 * 60 * 1000;
const ACCOUNT_TYPES = ["personal", undefined, "company"] as const;
const UNREADABLE = new Set(["channel_not_found", "thread_not_found", "not_in_channel"]);

class Overflow extends Error {}

class SlackError extends Error {
  readonly code: string;
  constructor(method: string, code: string) {
    super(`Slack ${method}: ${code}`);
    this.code = code;
  }
}

const run = (reason: string): InboxQuietVerdict => ({ quiet: false, reason });

// The sync pass repairs open items missing any of these before it scans.
function incomplete(item: LoopItem, source: string): boolean {
  const payload = item.sourcePayload;
  return (
    !item.proposal ||
    !item.sourceSummary ||
    typeof payload?.title !== "string" ||
    typeof payload.snippet !== "string" ||
    !isObj(payload[source])
  );
}

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
  // Closed-loop check: any message, in or out, on a thread the ledger still tracks.
  if ((await list(after)).some((message) => threads.has(message.threadId)))
    return "new message on a tracked Gmail thread";
  // New candidates: inbound inbox mail naming the user, or a send-as alias, in To or Cc.
  const { sendAs = [] } = await api<{ sendAs?: Array<{ sendAsEmail?: string }> }>("settings/sendAs");
  const addressed = ["me", ...sendAs.flatMap((alias) => (alias.sendAsEmail ? [alias.sendAsEmail] : []))]
    .flatMap((address) => [`to:${address}`, `cc:${address}`])
    .join(" ");
  if ((await list(`in:inbox -from:me {${addressed}} ${after}`)).length)
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

function slackConversation(item: LoopItem): SlackConversation | undefined {
  const meta = item.sourcePayload?.slack;
  if (!isObj(meta) || typeof meta.channelId !== "string" || typeof meta.ts !== "string") return undefined;
  const threadTs = typeof meta.threadTs === "string" ? meta.threadTs : undefined;
  if (meta.isDirectMessage === true && !threadTs) return { channelId: meta.channelId };
  return { channelId: meta.channelId, threadTs: threadTs ?? meta.ts };
}

export function createInboxQuietCheck(deps: QuietCheckDeps): InboxQuietCheck {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const slackBase = normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api");
  const bots = new LRUCache<string, boolean>({ max: 5000, ttl: 24 * 60 * 60 * 1000 });

  async function slack(token: string, method: string, params: Record<string, string>, tries = SLACK_RETRIES) {
    const res = await fetchImpl(`${slackBase}${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const retryAfter = Number(res.headers.get("retry-after") ?? 1);
    if (res.status === 429 && tries > 1 && retryAfter <= MAX_RETRY_AFTER_S) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return slack(token, method, params, tries - 1);
    }
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isObj(body)) throw new Error(`Slack ${method}: invalid response`);
    if (body.ok !== true) throw new SlackError(method, typeof body.error === "string" ? body.error : "not ok");
    return body;
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
    const after = `after:${new Date(cutoff - SEARCH_SLACK_MS).toISOString().slice(0, 10)}`;
    const tracks = (match: SlackMessage) =>
      tracked.some(
        (c) =>
          c.channelId === match.channel?.id &&
          (!c.threadTs || c.threadTs === threadOf(match) || c.threadTs === match.ts),
      );
    // DMs, group DMs and threads the user is in, plus @mentions anywhere.
    for (const query of [`with:me -from:me ${after}`, `<@${self}> ${after}`]) {
      for (const match of await search(token, query, cutoff)) {
        if (match.user === self) continue;
        if (tracks(match)) return "new Slack message in a tracked conversation";
        if (!match.user || !(await isBot(token, team, match.user))) return "new Slack message for the user";
      }
    }
    // Closed-loop check, part one: the user's own replies in a tracked conversation.
    if (tracked.length && (await search(token, `from:me ${after}`, cutoff)).some(tracks))
      return "the user replied in a tracked Slack conversation";
    return null;
  }

  // Closed-loop check, part two: other people's replies in tracked threads the user may
  // never have joined, which Slack's with:me search does not cover.
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
          // A conversation no connected account can read is unreadable to the sync pass too.
          if (!(error instanceof SlackError && UNREADABLE.has(error.code))) throw error;
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
        const gmail = item.sourcePayload?.gmail;
        if (!isObj(gmail) || typeof gmail.threadId !== "string") return run("an open item has no Gmail thread");
        threads.add(gmail.threadId);
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
      const conversation = slackConversation(item);
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
    if (open.some((item) => item.source !== source || incomplete(item, source)))
      return run("an open item needs repair");
    try {
      return await check(source, loop, open, loop.lastScanAt - OVERLAP_MS);
    } catch (error) {
      return run(error instanceof Overflow ? error.message : `pre-check failed: ${errMessage(error)}`);
    }
  };
}
