import { LRUCache } from "lru-cache";
import type { LoopItem } from "../types.ts";
import { isObj, tokenFor, type ConnectorTokenSource } from "../sources/adapter.ts";
import { gmailThreadOf } from "../sources/gmail.ts";
import { normalizeSlackApiUrl } from "../../slack/config.ts";
import { slackMessageContent } from "../../slack/message-content.ts";
import { GmailApiError, gmailApi } from "../../connectors/gmail-api.ts";
import type { DirectoryStore } from "../../directory/directory-store.ts";
import { newestTs, type Conversation, type TranscriptMessage } from "./transcript.ts";

export interface ConversationFetcherDeps {
  tokens: ConnectorTokenSource;
  directory?: Pick<DirectoryStore, "getBySlackId">;
  fetchImpl?: typeof fetch;
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
const CHANNEL_TTL = 5 * 60 * 1000;
const TIMEOUT_MS = 8000;
const GMAIL_BODY_CHARS = 6000;

export function changedSinceLastLook(item: Pick<LoopItem, "verdict">, conversation: Conversation): boolean {
  const newest = newestTs(conversation);
  return newest !== undefined && newest !== item.verdict?.lastSeenTs;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function plainText(part: Record<string, unknown>): string | undefined {
  const body = isObj(part.body) ? part.body : {};
  if (part.mimeType === "text/plain" && typeof body.data === "string") return decodeBase64Url(body.data);
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

export function createConversationFetcher(deps: ConversationFetcherDeps): ConversationFetcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const slackBase = normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api");
  const identities = new LRUCache<string, string>({ max: 500, ttl: IDENTITY_TTL });
  const channels = new LRUCache<string, boolean>({ max: 2000, ttl: CHANNEL_TTL });
  const names = new LRUCache<string, string>({ max: 5000, ttl: 24 * 60 * 60 * 1000 });
  const limited = new LRUCache<string, boolean>({ max: 100 });

  async function slackCall(owner: string, token: string, path: string): Promise<Record<string, unknown>> {
    const key = `${owner}:slack`;
    if (limited.has(key)) throw new SourceRateLimited("Slack");
    const res = await fetchImpl(`${slackBase}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      limited.set(key, true, { ttl: Math.max(60, Number.isFinite(retry) ? retry : 60) * 1000 });
      throw new SourceRateLimited("Slack");
    }
    const method = path.split("?")[0];
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isObj(body) || body.ok === false)
      throw new Error(
        `Slack ${method}: ${isObj(body) && typeof body.error === "string" ? body.error : "invalid response"}`,
      );
    return body;
  }

  async function slackIdentity(owner: string, token: string): Promise<string> {
    const cached = identities.get(owner);
    if (cached) return cached;
    const identity = await slackCall(owner, token, "auth.test");
    if (typeof identity.user_id !== "string") throw new Error("Slack auth.test returned no user id");
    identities.set(owner, identity.user_id);
    return identity.user_id;
  }

  async function slackDirect(owner: string, token: string, channelId: string): Promise<boolean> {
    const cached = channels.get(channelId);
    if (cached !== undefined) return cached;
    const info = await slackCall(owner, token, `conversations.info?channel=${encodeURIComponent(channelId)}`);
    const channel = isObj(info.channel) ? info.channel : {};
    const direct = channel.is_im === true || channel.is_mpim === true;
    channels.set(channelId, direct);
    return direct;
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
    const payload = item.sourcePayload ?? {};
    const meta = isObj(payload.slack) ? payload.slack : {};
    if (typeof meta.channelId !== "string" || typeof meta.ts !== "string")
      return { kind: "skipped", reason: "bad_item" };
    const token = await tokenFor(deps.tokens, "slack.com", owner);
    if (!token) return { kind: "skipped", reason: "not_connected" };
    const ownerId = await slackIdentity(owner, token);
    const direct = await slackDirect(owner, token, meta.channelId);
    const root = typeof meta.threadTs === "string" ? meta.threadTs : threadRootOf(meta.ts, direct);
    const channel = encodeURIComponent(meta.channelId);
    const body = await slackCall(
      owner,
      token,
      root
        ? `conversations.replies?channel=${channel}&ts=${encodeURIComponent(root)}&limit=100`
        : `conversations.history?channel=${channel}&limit=100`,
    );
    if (!Array.isArray(body.messages)) throw new Error("Slack returned no messages");
    const raw = body.messages
      .filter(isObj)
      .filter((m) => typeof m.ts === "string" && (!root || m.ts === root || m.thread_ts === root))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
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
    const label = typeof meta.channelLabel === "string" ? meta.channelLabel : slackLabelOf(meta.channelId, direct);
    return {
      kind: "conversation",
      conversation: { source: "slack", label, ...(root ? { rootTs: root } : {}), messages },
    };
  }

  async function gmail(owner: string, item: LoopItem): Promise<FetchOutcome> {
    const threadId = gmailThreadOf(item);
    if (!threadId) return { kind: "skipped", reason: "bad_item" };
    const token = await tokenFor(deps.tokens, "gmail.googleapis.com", owner);
    if (!token) return { kind: "skipped", reason: "not_connected" };
    const key = `${owner}:gmail`;
    if (limited.has(key)) throw new SourceRateLimited("Gmail");
    const api = gmailApi(token, fetchImpl);
    const read = async <T>(path: string): Promise<T> => {
      try {
        return await api<T>(path, { timeoutMs: TIMEOUT_MS });
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 429) {
          limited.set(key, true, { ttl: Math.max(60, error.retryAfterSeconds || 60) * 1000 });
          throw new SourceRateLimited("Gmail");
        }
        throw error;
      }
    };
    const address = (identities.get(`${owner}:gmail`) ??
      (await read<{ emailAddress?: string }>("profile")).emailAddress?.toLowerCase()) as string | undefined;
    if (address) identities.set(`${owner}:gmail`, address);
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
      const text = body ? stripQuoted(body).slice(0, GMAIL_BODY_CHARS) : snippet;
      const at = Number(m.internalDate);
      return {
        ts: String(m.internalDate),
        at,
        author: from || "unknown sender",
        owner: sent || (address !== undefined && from.toLowerCase().includes(address)),
        text,
        ...(hasAttachment(payload) ? { attachments: countAttachments(payload) } : {}),
      };
    });
    return {
      kind: "conversation",
      conversation: { source: "gmail", label: subject ? `Email "${subject}"` : "Email thread", messages },
    };
  }

  return async (owner, item) => {
    if (item.source === "slack") return slack(owner, item);
    if (item.source === "gmail") return gmail(owner, item);
    return { kind: "skipped", reason: "not_inbox" };
  };
}

function threadRootOf(ts: string, direct: boolean): string | undefined {
  return direct ? undefined : ts;
}

function slackLabelOf(channelId: string, direct: boolean): string {
  return direct ? "Slack DM" : `Slack #${channelId}`;
}

function countAttachments(part: Record<string, unknown>): number {
  const own = typeof part.filename === "string" && part.filename ? 1 : 0;
  const parts = Array.isArray(part.parts) ? part.parts.filter(isObj) : [];
  return own + parts.reduce((sum, nested) => sum + countAttachments(nested), 0);
}

function hasAttachment(part: Record<string, unknown>): boolean {
  return countAttachments(part) > 0;
}
