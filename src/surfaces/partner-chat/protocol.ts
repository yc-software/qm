import { createHmac, timingSafeEqual } from "node:crypto";
import { isObj } from "../../util/objects.ts";

const MAX_CLOCK_SKEW_S = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_ID_WIDTH = 10;

export interface PartnerChatUser {
  id: string;
  email?: string;
  name?: string;
  bot?: boolean;
}

export interface PartnerChatEvent {
  event_id: string;
  type: "message.created" | "message.updated" | "message.deleted";
  account: string;
  chat: { id: string; kind: "group" | "dm"; name?: string; members: PartnerChatUser[] };
  thread_id?: string;
  message: { id: string; user: PartnerChatUser; body: string; mentions_agent: boolean; created_at: string };
}

export interface PartnerChatChat {
  account: string;
  kind: "group" | "dm";
  chat: string;
  thread?: string;
}

export function signPartnerChat(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyPartnerChat(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowMs: number,
): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_S) return false;
  const expected = Buffer.from(signPartnerChat(secret, timestamp, rawBody));
  const actual = Buffer.from(signature ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function partnerChatRef(c: PartnerChatChat): string {
  return ["partner-chat", c.account, c.kind, c.chat, ...(c.thread ? [c.thread] : [])].join(":");
}

export function parsePartnerChatRef(ref: string): PartnerChatChat | null {
  const [surface, account, kind, chat, thread, ...rest] = ref.split(":");
  if (surface !== "partner-chat" || !account || !chat || rest.length || (kind !== "group" && kind !== "dm"))
    return null;
  return { account, kind, chat, ...(thread ? { thread } : {}) };
}

export function partnerChatTs(createdAt: string, messageId: string): string {
  return `${Math.floor(Date.parse(createdAt) / 1000)}.${messageId.padStart(MESSAGE_ID_WIDTH, "0")}`;
}

export function partnerChatMessageId(ref: string): string {
  const dot = ref.indexOf(".");
  return dot < 0 ? ref : ref.slice(dot + 1).replace(/^0+(?=.)/, "");
}

const id = (v: unknown): string | null => (typeof v === "string" && ID_PATTERN.test(v) ? v : null);
const optString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function parseUser(raw: unknown): PartnerChatUser | null {
  if (!isObj(raw)) return null;
  const userId = id(raw.id);
  if (!userId) return null;
  const email = optString(raw.email);
  const name = optString(raw.name);
  return {
    id: userId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(raw.bot === true ? { bot: true } : {}),
  };
}

export function parsePartnerChatEvent(raw: unknown): PartnerChatEvent | null {
  if (!isObj(raw) || !isObj(raw.chat) || !isObj(raw.message)) return null;
  const { chat, message } = raw;
  const type = raw.type;
  if (type !== "message.created" && type !== "message.updated" && type !== "message.deleted") return null;
  const eventId = optString(raw.event_id);
  const account = id(raw.account);
  const chatId = id(chat.id);
  const messageId = id(message.id);
  const threadId = raw.thread_id === undefined || raw.thread_id === null ? undefined : id(raw.thread_id);
  const user = parseUser(message.user);
  const members = Array.isArray(chat.members) ? chat.members.map(parseUser) : null;
  const createdAt = optString(message.created_at);
  if (
    !eventId ||
    !account ||
    !chatId ||
    !messageId ||
    threadId === null ||
    !user ||
    !members ||
    members.some((m) => m === null) ||
    (chat.kind !== "group" && chat.kind !== "dm") ||
    typeof message.body !== "string" ||
    !createdAt ||
    Number.isNaN(Date.parse(createdAt))
  )
    return null;
  const name = optString(chat.name);
  return {
    event_id: eventId,
    type,
    account,
    chat: { id: chatId, kind: chat.kind, ...(name ? { name } : {}), members: members as PartnerChatUser[] },
    ...(threadId ? { thread_id: threadId } : {}),
    message: {
      id: messageId,
      user,
      body: message.body,
      mentions_agent: message.mentions_agent === true,
      created_at: createdAt,
    },
  };
}
