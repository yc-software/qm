import { ErrorCode, WebClient } from "@slack/web-api";
import { LRUCache } from "lru-cache";
import type { LoopItem } from "../types.ts";
import { isObj, tokenFor, type ConnectorTokenSource } from "../sources/adapter.ts";
import { gmailThreadOf } from "../sources/gmail.ts";
import { slackConversationOf } from "../sources/slack.ts";
import { normalizeSlackApiUrl } from "../../slack/config.ts";
import { slackMessageContent } from "../../slack/message-content.ts";
import { slackWebClient } from "../../slack/web-client.ts";
import { GmailApiError, gmailApi } from "../../connectors/gmail-api.ts";
import type { DirectoryStore } from "../../directory/directory-store.ts";
import { newestTs, TRANSCRIPT_TAIL, type Conversation, type TranscriptMessage } from "./transcript.ts";

type SlackReader = Pick<WebClient, "apiCall">;

export interface ConversationFetcherDeps {
  tokens: ConnectorTokenSource;
  directory?: Pick<DirectoryStore, "getBySlackId">;
  fetchImpl?: typeof fetch;
  slackClient?: (token: string) => SlackReader;
  slackApiUrl?: string;
}

type FetchOutcome =
  | { kind: "conversation"; conversation: Conversation }
  | { kind: "skipped"; reason: "not_connected" | "not_inbox" | "bad_item" };

export class SourceRateLimited extends Error {
  constructor(source: string) {
    super(`${source} rate limited; the next sync will retry`);
  }
}

export type ConversationFetcher = (owner: string, item: LoopItem) => Promise<FetchOutcome>;

const IDENTITY_TTL = 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 10_000;
const SLACK_PAGE = 200;

export function changedSinceLastLook(item: Pick<LoopItem, "verdict">, conversation: Conversation): boolean {
  const newest = newestTs(conversation);
  return newest !== undefined && newest !== item.verdict?.lastSeenTs;
}

function plainText(part: Record<string, unknown>): string | undefined {
  const body = isObj(part.body) ? part.body : {};
  if (part.mimeType === "text/plain" && typeof body.data === "string")
    return Buffer.from(body.data, "base64url").toString("utf8");
  const parts = Array.isArray(part.parts) ? part.parts.filter(isObj) : [];
  for (const nested of parts) {
    const text = plainText(nested);
    if (text) return text;
  }
  return undefined;
}

function header(payload: Record<string, unknown>, name: string): string {
  const headers = Array.isArray(payload.headers) ? payload.headers.filter(isObj) : [];
  const found = headers.find((h) => typeof h.name === "string" && h.name.toLowerCase() === name.toLowerCase());
  return typeof found?.value === "string" ? found.value : "";
}

function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((line) => /^On .+wrote:\s*$/.test(line.trim()) || line.startsWith(">"));
  return (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}

function countAttachments(part: Record<string, unknown>): number {
  const own = typeof part.filename === "string" && part.filename ? 1 : 0;
  const parts = Array.isArray(part.parts) ? part.parts.filter(isObj) : [];
  return own + parts.reduce((sum, nested) => sum + countAttachments(nested), 0);
}

function rateLimitedAfter(error: unknown): number | undefined {
  if (!isObj(error) || error.code !== ErrorCode.RateLimitedError) return undefined;
  return typeof error.retryAfter === "number" ? error.retryAfter : 60;
}

export function createConversationFetcher(deps: ConversationFetcherDeps): ConversationFetcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const slackApiUrl = normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api");
  const slackClient =
    deps.slackClient ??
    ((token: string) =>
      slackWebClient(token, (t, options) => new WebClient(t, { ...options, slackApiUrl }), SOURCE_TIMEOUT_MS));
  const identities = new LRUCache<string, string>({ max: 500, ttl: IDENTITY_TTL });
  const names = new LRUCache<string, string>({ max: 5000, ttl: 24 * 60 * 60 * 1000 });
  const limited = new LRUCache<string, boolean>({ max: 100 });

  function limitFor(owner: string, source: string, seconds: number): never {
    limited.set(`${owner}:${source}`, true, { ttl: Math.max(60, seconds) * 1000 });
    throw new SourceRateLimited(source);
  }

  async function slackCall(owner: string, token: string, method: string, params: Record<string, string>) {
    if (limited.has(`${owner}:Slack`)) throw new SourceRateLimited("Slack");
    try {
      const body: unknown = await slackClient(token).apiCall(method, params);
      return isObj(body) ? body : {};
    } catch (error) {
      const after = rateLimitedAfter(error);
      return after === undefined ? Promise.reject(error) : limitFor(owner, "Slack", after);
    }
  }

  async function slackIdentity(owner: string, token: string): Promise<string> {
    const cached = identities.get(`${owner}:slack`);
    if (cached) return cached;
    const identity = await slackCall(owner, token, "auth.test", {});
    if (typeof identity.user_id !== "string") throw new Error("Slack auth.test returned no user id");
    identities.set(`${owner}:slack`, identity.user_id);
    return identity.user_id;
  }

  async function slackMessages(
    owner: string,
    token: string,
    channel: string,
    root: string | undefined,
    ownerId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const collected: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const body = await slackCall(owner, token, root ? "conversations.replies" : "conversations.history", {
        channel,
        limit: String(SLACK_PAGE),
        ...(root ? { ts: root } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(body.messages)) throw new Error("Slack returned no messages");
      collected.push(...body.messages.filter(isObj).filter((m) => typeof m.ts === "string"));
      const next = isObj(body.response_metadata) ? body.response_metadata.next_cursor : undefined;
      cursor = typeof next === "string" && next ? next : undefined;
      const enough = !root && collected.length >= TRANSCRIPT_TAIL && collected.some((m) => m.user === ownerId);
      if (enough) cursor = undefined;
    } while (cursor);
    return collected
      .filter((m) => !root || m.ts === root || m.thread_ts === root)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async function slackName(id: string, saved: Map<string, string>): Promise<string> {
    const known = saved.get(id) ?? names.get(id);
    if (known) return known;
    const member = await deps.directory?.getBySlackId(id).catch(() => null);
    const name = member?.displayName || id;
    names.set(id, name);
    return name;
  }

  async function slack(owner: string, item: LoopItem): Promise<FetchOutcome> {
    const target = slackConversationOf(item);
    if (!target) return { kind: "skipped", reason: "bad_item" };
    const token = await tokenFor(deps.tokens, "slack.com", owner);
    if (!token) return { kind: "skipped", reason: "not_connected" };
    const ownerId = await slackIdentity(owner, token);
    const raw = await slackMessages(owner, token, target.channelId, target.threadTs, ownerId);
    const payload = item.sourcePayload ?? {};
    const saved = new Map<string, string>(
      (Array.isArray(payload.participants) ? payload.participants.filter(isObj) : []).flatMap((person) =>
        typeof person.id === "string" && typeof person.name === "string" ? [[person.id, person.name]] : [],
      ),
    );
    const messages: TranscriptMessage[] = [];
    for (const m of raw) {
      const userId = typeof m.user === "string" ? m.user : undefined;
      const botName = isObj(m.bot_profile) && typeof m.bot_profile.name === "string" ? m.bot_profile.name : undefined;
      const author = userId ? await slackName(userId, saved) : botName || String(m.username ?? "Slack");
      const content = slackMessageContent(m);
      messages.push({
        ts: String(m.ts),
        at: Math.round(Number(m.ts) * 1000),
        author,
        owner: userId === ownerId,
        text: content.text,
        ...(content.files.length ? { attachments: content.files.length } : {}),
      });
    }
    const meta = isObj(payload.slack) ? payload.slack : {};
    const label = typeof meta.channelLabel === "string" ? meta.channelLabel : `Slack ${target.channelId}`;
    return {
      kind: "conversation",
      conversation: { source: "slack", label, ...(target.threadTs ? { rootTs: target.threadTs } : {}), messages },
    };
  }

  async function gmail(owner: string, item: LoopItem): Promise<FetchOutcome> {
    const threadId = gmailThreadOf(item);
    if (!threadId) return { kind: "skipped", reason: "bad_item" };
    const token = await tokenFor(deps.tokens, "gmail.googleapis.com", owner);
    if (!token) return { kind: "skipped", reason: "not_connected" };
    if (limited.has(`${owner}:Gmail`)) throw new SourceRateLimited("Gmail");
    const api = gmailApi(token, fetchImpl);
    const read = async <T>(path: string): Promise<T> => {
      try {
        return await api<T>(path, { timeoutMs: SOURCE_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 429) limitFor(owner, "Gmail", error.retryAfterSeconds);
        throw error;
      }
    };
    let address = identities.get(`${owner}:gmail`);
    if (!address) {
      address = (await read<{ emailAddress?: string }>("profile")).emailAddress?.toLowerCase();
      if (address) identities.set(`${owner}:gmail`, address);
    }
    const thread = await read<{ messages?: unknown[] }>(`threads/${encodeURIComponent(threadId)}?format=full`);
    const raw = (Array.isArray(thread.messages) ? thread.messages.filter(isObj) : [])
      .filter((m) => !(Array.isArray(m.labelIds) && m.labelIds.includes("DRAFT")))
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    let subject = "";
    const messages = raw.map((m): TranscriptMessage => {
      const payload = isObj(m.payload) ? m.payload : {};
      subject ||= header(payload, "Subject");
      const from = header(payload, "From");
      const sent = Array.isArray(m.labelIds) && m.labelIds.includes("SENT");
      const body = plainText(payload);
      const snippet = typeof m.snippet === "string" ? m.snippet : "";
      const attachments = countAttachments(payload);
      return {
        ts: String(m.internalDate),
        at: Number(m.internalDate),
        author: from || "unknown sender",
        owner: sent || (address !== undefined && from.toLowerCase().includes(address)),
        text: body ? stripQuoted(body) : snippet,
        ...(attachments ? { attachments } : {}),
      };
    });
    const label = subject ? `Email "${subject}"` : "Email thread";
    return { kind: "conversation", conversation: { source: "gmail", label, messages } };
  }

  return async (owner, item) => {
    if (item.source === "slack") return slack(owner, item);
    if (item.source === "gmail") return gmail(owner, item);
    return { kind: "skipped", reason: "not_inbox" };
  };
}
