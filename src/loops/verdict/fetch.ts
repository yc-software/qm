import { ErrorCode, WebClient } from "@slack/web-api";
import { LRUCache } from "lru-cache";
import type { LoopItem } from "../types.ts";
import { isObj, tokenFor, type ConnectorTokenSource } from "../sources/adapter.ts";
import { gmailAccountOf, gmailThreadOf, gmailToken } from "../sources/gmail.ts";
import { slackConversationOf } from "../sources/slack.ts";
import { normalizeSlackApiUrl } from "../../slack/config.ts";
import { slackMessageContent } from "../../slack/message-content.ts";
import { slackWebClient } from "../../slack/web-client.ts";
import { GmailApiError, gmailApi } from "../../connectors/gmail-api.ts";
import { header, mailboxes, plainText } from "../../connectors/gmail-compose.ts";
import { TransientTurnFailure } from "../../core/turn-error.ts";
import { perTenant } from "../../tenants/cache.ts";
import {
  newestTs,
  TRANSCRIPT_TAIL,
  type Conversation,
  type Participant,
  type TranscriptMessage,
} from "./transcript.ts";

type SlackReader = Pick<WebClient, "apiCall">;

export interface SourceClientDeps {
  tokens: ConnectorTokenSource;
  fetchImpl?: typeof fetch;
  slackClient?: (token: string) => SlackReader;
  slackApiUrl?: string;
}

type FetchOutcome =
  | { kind: "conversation"; conversation: Conversation }
  | { kind: "skipped"; reason: "not_connected" | "not_inbox" | "bad_item" }
  | { kind: "skipped"; reason: "source_gone"; message: string };

export class SourceRateLimited extends TransientTurnFailure {
  constructor(source: string) {
    super(`${source} rate limited; the next sync will retry`);
  }
}

interface SlackIdentity {
  userId: string;
  teamUrl: string;
}

interface SlackChannel {
  direct: boolean;
  name?: string;
}

export interface SourceClients {
  slackToken(owner: string): Promise<string | null>;
  slackCall(
    owner: string,
    token: string,
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>>;
  slackIdentity(owner: string, token: string): Promise<SlackIdentity>;
  slackChannel(owner: string, token: string, channelId: string): Promise<SlackChannel>;
  slackUser(owner: string, token: string, userId: string): Promise<Participant>;
  gmailToken(owner: string, item?: LoopItem): Promise<string | null>;
  gmailRead<T>(owner: string, token: string, path: string): Promise<T>;
  gmailAddress(owner: string, token: string, item: LoopItem): Promise<string | undefined>;
}

export type ConversationFetcher = (owner: string, item: LoopItem) => Promise<FetchOutcome>;

const IDENTITY_TTL = 60 * 60 * 1000;
const DAY_TTL = 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 10_000;
const SLACK_PAGE = 200;

export function changedSinceLastLook(item: Pick<LoopItem, "verdict">, conversation: Conversation): boolean {
  const newest = newestTs(conversation);
  return newest !== undefined && newest !== item.verdict?.lastSeenTs;
}

const goneSlackErrors = new Map([
  ["channel_not_found", "The conversation is no longer available in Slack."],
  ["thread_not_found", "The conversation is no longer available in Slack."],
  ["not_in_channel", "You are no longer a member of this Slack channel."],
  ["is_archived", "This Slack channel was archived."],
]);

function sourceGone(error: unknown): string | undefined {
  if (error instanceof GmailApiError)
    return error.status === 404 ? "The conversation is no longer available in Gmail." : undefined;
  const code =
    isObj(error) && error.code === ErrorCode.PlatformError && isObj(error.data) ? error.data.error : undefined;
  return typeof code === "string" ? goneSlackErrors.get(code) : undefined;
}

function rateLimitedAfter(error: unknown): number | undefined {
  if (!isObj(error) || error.code !== ErrorCode.RateLimitedError) return undefined;
  return typeof error.retryAfter === "number" ? error.retryAfter : 60;
}

export function createSourceClients(deps: SourceClientDeps): SourceClients {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const slackApiUrl = normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api");
  const slackClient =
    deps.slackClient ??
    ((token: string) =>
      slackWebClient(token, (t, options) => new WebClient(t, { ...options, slackApiUrl }), SOURCE_TIMEOUT_MS));
  const identities = perTenant(() => new LRUCache<string, SlackIdentity>({ max: 500, ttl: IDENTITY_TTL }));
  const addresses = perTenant(() => new LRUCache<string, string>({ max: 500, ttl: IDENTITY_TTL }));
  const channels = perTenant(() => new LRUCache<string, SlackChannel>({ max: 5000, ttl: DAY_TTL }));
  const users = perTenant(() => new LRUCache<string, Participant>({ max: 5000, ttl: DAY_TTL }));
  const limited = perTenant(() => new LRUCache<string, boolean>({ max: 100 }));

  function limitFor(owner: string, source: string, seconds: number): never {
    limited().set(`${owner}:${source}`, true, { ttl: Math.max(60, seconds) * 1000 });
    throw new SourceRateLimited(source);
  }

  const clients: SourceClients = {
    slackToken: (owner) => tokenFor(deps.tokens, "slack.com", owner),
    async slackCall(owner, token, method, params) {
      if (limited().has(`${owner}:Slack`)) throw new SourceRateLimited("Slack");
      try {
        const body: unknown = await slackClient(token).apiCall(method, params);
        return isObj(body) ? body : {};
      } catch (error) {
        const after = rateLimitedAfter(error);
        return after === undefined ? Promise.reject(error) : limitFor(owner, "Slack", after);
      }
    },
    async slackIdentity(owner, token) {
      const cached = identities().get(owner);
      if (cached) return cached;
      const identity = await clients.slackCall(owner, token, "auth.test", {});
      if (typeof identity.user_id !== "string") throw new Error("Slack auth.test returned no user id");
      const resolved = { userId: identity.user_id, teamUrl: typeof identity.url === "string" ? identity.url : "" };
      identities().set(owner, resolved);
      return resolved;
    },
    async slackChannel(owner, token, channelId) {
      const cached = channels().get(channelId);
      if (cached) return cached;
      const info = await clients.slackCall(owner, token, "conversations.info", { channel: channelId });
      const channel = isObj(info.channel) ? info.channel : {};
      const resolved = {
        direct: channel.is_im === true || channel.is_mpim === true,
        ...(typeof channel.name === "string" && channel.name ? { name: channel.name } : {}),
      };
      channels().set(channelId, resolved);
      return resolved;
    },
    async slackUser(owner, token, userId) {
      const cached = users().get(userId);
      if (cached) return cached;
      const info = await clients.slackCall(owner, token, "users.info", { user: userId });
      const user = isObj(info.user) ? info.user : {};
      const profile = isObj(user.profile) ? user.profile : {};
      const name =
        [profile.display_name, user.real_name, profile.real_name, user.name].find(
          (value) => typeof value === "string" && value,
        ) ?? userId;
      const avatar = profile.image_72;
      const resolved = { id: userId, name: String(name), ...(typeof avatar === "string" ? { avatarUrl: avatar } : {}) };
      users().set(userId, resolved);
      return resolved;
    },
    gmailToken: (owner, item) =>
      item ? gmailToken(deps.tokens, owner, item) : tokenFor(deps.tokens, "gmail.googleapis.com", owner),
    async gmailRead(owner, token, path) {
      if (limited().has(`${owner}:Gmail`)) throw new SourceRateLimited("Gmail");
      try {
        return await gmailApi(token, fetchImpl)(path, { timeoutMs: SOURCE_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 429) limitFor(owner, "Gmail", error.retryAfterSeconds);
        throw error;
      }
    },
    async gmailAddress(owner, token, item) {
      const key = `${owner}:${gmailAccountOf(item) ?? ""}`;
      const cached = addresses().get(key);
      if (cached) return cached;
      const profile = await clients.gmailRead<{ emailAddress?: string }>(owner, token, "profile");
      const address = profile.emailAddress?.toLowerCase();
      if (address) addresses().set(key, address);
      return address;
    },
  };
  return clients;
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

function formatMailbox(box: { address: string; name: string }): string {
  return box.name ? `${box.name} <${box.address}>` : box.address;
}

export function slackPermalink(teamUrl: string, channelId: string, ts: string, threadTs?: string): string | undefined {
  if (!teamUrl) return undefined;
  const base = `${teamUrl.replace(/\/$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

export function createConversationFetcher(clients: SourceClients): ConversationFetcher {
  async function slackMessages(
    owner: string,
    token: string,
    channel: string,
    root: string | undefined,
    ownerId: string,
  ): Promise<{ messages: Array<Record<string, unknown>>; partial: boolean }> {
    const collected: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let partial = false;
    do {
      const body = await clients.slackCall(owner, token, root ? "conversations.replies" : "conversations.history", {
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
      if (enough && cursor) {
        partial = true;
        cursor = undefined;
      }
    } while (cursor);
    const messages = collected
      .filter((m) => !root || m.ts === root || m.thread_ts === root)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    return { messages, partial };
  }

  async function slack(owner: string, item: LoopItem): Promise<FetchOutcome> {
    const target = slackConversationOf(item);
    if (!target) return { kind: "skipped", reason: "bad_item" };
    const token = await clients.slackToken(owner);
    if (!token) return { kind: "skipped", reason: "not_connected" };
    const identity = await clients.slackIdentity(owner, token);
    const { messages: raw, partial } = await slackMessages(
      owner,
      token,
      target.channelId,
      target.threadTs,
      identity.userId,
    );
    const meta = isObj(item.sourcePayload?.slack) ? item.sourcePayload.slack : {};
    const channel =
      typeof meta.isDirectMessage === "boolean" && typeof meta.channelLabel === "string"
        ? { direct: meta.isDirectMessage, label: meta.channelLabel }
        : await clients.slackChannel(owner, token, target.channelId).then((info) => ({
            direct: info.direct,
            label: info.name ? `#${info.name}` : "",
          }));
    const participants = new Map<string, Participant>();
    const messages: TranscriptMessage[] = [];
    for (const m of raw) {
      const userId = typeof m.user === "string" ? m.user : undefined;
      const botName = isObj(m.bot_profile) && typeof m.bot_profile.name === "string" ? m.bot_profile.name : undefined;
      const person = userId ? await clients.slackUser(owner, token, userId) : undefined;
      if (person) participants.set(person.id, person);
      const content = slackMessageContent(m);
      const images = content.files.flatMap((file) =>
        file.mimetype?.startsWith("image/") && file.url_private ? [file.url_private] : [],
      );
      messages.push({
        ts: String(m.ts),
        at: Math.round(Number(m.ts) * 1000),
        author: person?.name ?? botName ?? String(m.username ?? "Slack"),
        ...(userId ? { authorId: userId } : {}),
        owner: userId === identity.userId,
        text: content.text,
        ...(images.length ? { images } : {}),
        ...(content.files.length ? { attachments: content.files.length } : {}),
      });
    }
    const others = [...participants.values()].filter((person) => person.id !== identity.userId);
    const label =
      channel.label ||
      (others.length ? `DM with ${others.map((person) => person.name).join(", ")}` : `Slack ${target.channelId}`);
    const newest = messages.at(-1);
    return {
      kind: "conversation",
      conversation: {
        source: "slack",
        label,
        ...(newest
          ? { externalUrl: slackPermalink(identity.teamUrl, target.channelId, newest.ts, target.threadTs) }
          : {}),
        ...(target.threadTs ? { rootTs: target.threadTs } : {}),
        ...(partial ? { partial: true } : {}),
        messages,
        participants: [...participants.values()],
        slack: {
          channelId: target.channelId,
          ...(target.threadTs ? { threadTs: target.threadTs } : {}),
          isDirectMessage: channel.direct,
          channelLabel: label,
        },
      },
    };
  }

  async function gmail(owner: string, item: LoopItem): Promise<FetchOutcome> {
    const threadId = gmailThreadOf(item);
    if (!threadId) return { kind: "skipped", reason: "bad_item" };
    const token = await clients.gmailToken(owner, item);
    if (!token) return { kind: "skipped", reason: "not_connected" };
    const address = await clients.gmailAddress(owner, token, item);
    const thread = await clients.gmailRead<{ messages?: unknown[] }>(
      owner,
      token,
      `threads/${encodeURIComponent(threadId)}?format=full`,
    );
    const raw = (Array.isArray(thread.messages) ? thread.messages.filter(isObj) : [])
      .filter((m) => !(Array.isArray(m.labelIds) && m.labelIds.includes("DRAFT")))
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    let subject = "";
    const isOwner = (box: { address: string }) => address !== undefined && box.address.toLowerCase() === address;
    const messages = raw.map((m): TranscriptMessage => {
      const payload = isObj(m.payload) ? m.payload : {};
      subject ||= header(payload, "Subject");
      const from = mailboxes(header(payload, "From"))[0];
      const sent = Array.isArray(m.labelIds) && m.labelIds.includes("SENT");
      const owner = sent || (from !== undefined && isOwner(from));
      const body = plainText(payload);
      const snippet = typeof m.snippet === "string" ? m.snippet : "";
      const attachments = countAttachments(payload);
      const to = mailboxes(header(payload, "To")).filter((box) => !isOwner(box));
      const cc = mailboxes(header(payload, "Cc")).filter((box) => !isOwner(box));
      const rfcMessageId = header(payload, "Message-ID");
      return {
        ts: String(m.internalDate),
        at: Number(m.internalDate),
        author: from?.name || from?.address || "unknown sender",
        ...(from ? { authorId: from.address, authorDetail: from.address } : {}),
        owner,
        text: body ? stripQuoted(body) : snippet,
        ...(attachments ? { attachments } : {}),
        ...(!owner && typeof m.id === "string"
          ? {
              reply: {
                messageId: m.id,
                ...(rfcMessageId ? { rfcMessageId } : {}),
                to: [...new Set([from, ...to].filter((box) => box !== undefined).map(formatMailbox))],
                cc: cc.map(formatMailbox),
              },
            }
          : {}),
      };
    });
    const label = subject || "Email thread";
    return {
      kind: "conversation",
      conversation: {
        source: "gmail",
        label,
        ...(address
          ? { externalUrl: `https://mail.google.com/mail/u/${encodeURIComponent(address)}/#inbox/${threadId}` }
          : {}),
        messages,
        gmail: { threadId, ...(subject ? { subject } : {}), ...(address ? { accountEmail: address } : {}) },
      },
    };
  }

  return async (owner, item) => {
    try {
      if (item.source === "slack") return await slack(owner, item);
      if (item.source === "gmail") return await gmail(owner, item);
    } catch (error) {
      const message = sourceGone(error);
      if (message) return { kind: "skipped", reason: "source_gone", message };
      throw error;
    }
    return { kind: "skipped", reason: "not_inbox" };
  };
}
