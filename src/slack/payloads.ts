import bolt, { type LogLevel } from "@slack/bolt";
import { isObj } from "../util/objects.ts";
import type { SlackFile } from "./attachments.ts";

function rec(v: unknown): Record<string, unknown> | undefined {
  return isObj(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function coerced(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

export function parseEventId(body: unknown): string | undefined {
  return str(rec(body)?.event_id);
}

export interface SlackMessageEvent {
  channel: string;
  channel_type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  client_msg_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  deleted_ts?: string;
  files: SlackFile[];
  message?: SlackMessageEvent;
  previous_message?: { user?: string; bot_id?: string; thread_ts?: string; text?: string };
}

function fileList(v: unknown): SlackFile[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    console.error("[slack] dropping malformed files list on a message event (expected an array)");
    return [];
  }
  return v;
}

export function parseMessageEvent(event: unknown): SlackMessageEvent {
  const e = rec(event) ?? {};
  const botProfile = rec(e.bot_profile);
  const prev = rec(e.previous_message);
  const nested = rec(e.message);
  return {
    ...e,
    channel: coerced(e.channel) ?? "",
    channel_type: str(e.channel_type),
    subtype: str(e.subtype),
    user: str(e.user),
    username: str(e.username),
    bot_id: str(e.bot_id),
    bot_profile: botProfile ? { name: str(botProfile.name) } : undefined,
    client_msg_id: str(e.client_msg_id),
    text: str(e.text),
    ts: coerced(e.ts) ?? "",
    thread_ts: coerced(e.thread_ts),
    deleted_ts: coerced(e.deleted_ts),
    files: fileList(e.files),
    message: nested ? parseMessageEvent(nested) : undefined,
    previous_message: prev
      ? {
          user: str(prev.user),
          bot_id: str(prev.bot_id),
          thread_ts: coerced(prev.thread_ts),
          ...(typeof prev.text === "string" ? { text: prev.text } : {}),
        }
      : undefined,
  };
}

export interface SlackReactionEvent {
  user?: string;
  reaction?: string;
  item_user?: string;
  item?: { type?: string; channel?: string; ts?: string };
  event_ts?: string;
}

export function parseReactionEvent(event: unknown): SlackReactionEvent {
  const e = rec(event) ?? {};
  const item = rec(e.item);
  return {
    user: str(e.user),
    reaction: str(e.reaction),
    item_user: str(e.item_user),
    item: item ? { type: str(item.type), channel: str(item.channel), ts: coerced(item.ts) } : undefined,
    event_ts: coerced(e.event_ts),
  };
}

interface SlackLifecycleEvent {
  user?: string;
  channel?: string;
  eventTs?: string;
}

export function parseLifecycleEvent(event: unknown): SlackLifecycleEvent {
  const e = rec(event) ?? {};
  return {
    user: str(e.user),
    channel: str(e.channel) ?? str(rec(e.channel)?.id),
    eventTs: coerced(e.event_ts),
  };
}

interface SlackInteraction {
  clickerId: string;
  channel?: string;
  messageTs?: string;
  messageThreadTs?: string;
}

export function parseInteractionBody(body: unknown): SlackInteraction {
  const b = rec(body) ?? {};
  const message = rec(b.message);
  return {
    clickerId: String(rec(b.user)?.id ?? ""),
    channel: coerced(rec(b.channel)?.id),
    messageTs: coerced(message?.ts),
    messageThreadTs: coerced(message?.thread_ts),
  };
}

export function parseBlockAction<T extends string>(
  action: unknown,
  actionIds: readonly T[],
): { actionId: T; value: string } | undefined {
  const a = rec(action) ?? {};
  const raw = str(a.action_id);
  const actionId = actionIds.find((id) => id === raw);
  return actionId === undefined ? undefined : { actionId, value: String(a.value ?? "") };
}

export interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: unknown;
  reactions?: unknown;
  files?: SlackFile[];
}

export function parseMessageList(res: unknown): { messages: SlackHistoryMessage[]; hasMore: boolean } {
  const r = rec(res);
  const list = r?.messages;
  return { messages: Array.isArray(list) ? list : [], hasMore: Boolean(r?.has_more) };
}

function fileIdsOf(entries: unknown): string[] {
  return Object.values(rec(entries) ?? {}).flatMap((entry) => {
    const e = rec(entry);
    const id = coerced(e?.id);
    return id ? [id] : fileIdsOf(e?.files);
  });
}

export function parseUploadedFileIds(res: unknown): string[] {
  const r = rec(res) ?? {};
  return r.file ? fileIdsOf([r.file]) : fileIdsOf(r.files);
}

export function channelShareTs(res: unknown, channel: string): string | undefined {
  const shares = rec(rec(rec(res)?.file)?.shares) ?? {};
  for (const list of [rec(shares.public)?.[channel], rec(shares.private)?.[channel]]) {
    if (list == null) continue;
    if (!Array.isArray(list)) throw new TypeError("malformed file.shares entry (expected an array)");
    const ts = list.map((s) => coerced(rec(s)?.ts)).find((value) => value !== undefined);
    if (ts) return ts;
  }
  return undefined;
}

export function parseChannelPage(res: unknown): Array<{ id?: string; is_member?: boolean }> {
  const channels = rec(res)?.channels;
  return Array.isArray(channels) ? channels : [];
}

export function slackErrorCode(err: unknown): string | undefined {
  return str(rec(rec(err)?.data)?.error);
}

const LOG_LEVELS: readonly LogLevel[] = [
  bolt.LogLevel.ERROR,
  bolt.LogLevel.WARN,
  bolt.LogLevel.INFO,
  bolt.LogLevel.DEBUG,
];

export function parseLogLevel(v: string | undefined): LogLevel {
  if (v === undefined) return bolt.LogLevel.INFO;
  const match = LOG_LEVELS.find((l) => l === v);
  if (match) return match;
  console.error(`[slack] unknown log level "${v}" — using info`);
  return bolt.LogLevel.INFO;
}
