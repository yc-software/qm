import { z } from "zod";
import { hmacHex } from "../../webhooks/verifiers.ts";
import { constantTimeEqual } from "../../util/crypto.ts";
import type { CachedMessage, SurfaceCache } from "../../surface-cache/types.ts";

export const PARTNER_CHAT = "partner-chat";

const MAX_CLOCK_SKEW_S = 300;
const MESSAGE_ID_WIDTH = 20;

const ID = /^[A-Za-z0-9_-]+$/;
const id = z.string().regex(ID);
export const partnerChatMessageIdSchema = z.string().regex(/^\d{1,20}$/);
const user = z.object({
  id,
  email: z.string().optional(),
  name: z.string().optional(),
  bot: z.boolean().optional(),
});
const file = z.object({
  id: partnerChatMessageIdSchema,
  name: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative().optional(),
});
const eventSchema = z.object({
  protocol: z.literal(2).optional(),
  event_id: z.string().min(1),
  type: z.enum(["message.created", "message.updated", "message.deleted"]),
  account: id,
  chat: z.object({ id, kind: z.enum(["group", "dm"]), name: z.string().optional(), members: z.array(user) }),
  thread_id: partnerChatMessageIdSchema.nullish(),
  message: z.object({
    id: partnerChatMessageIdSchema,
    user,
    body: z.string(),
    mentions_agent: z.boolean().default(false),
    app_post: z.boolean().default(false),
    files: z.array(file).default([]),
    created_at: z.iso.datetime({ offset: true }),
  }),
});

const actionEventSchema = eventSchema.extend({
  protocol: z.literal(2),
  type: z.literal("action.invoked"),
  action: z.object({ id: z.string().min(1), user }),
});

const reactionEventSchema = eventSchema.extend({
  protocol: z.literal(2),
  type: z.enum(["reaction.added", "reaction.removed"]),
  reaction: z.object({ name: z.string().min(1), user }),
});

export type PartnerChatUser = z.infer<typeof user>;
export type PartnerChatEvent = z.infer<typeof eventSchema>;
export type PartnerChatFile = z.infer<typeof file>;
export type PartnerChatReactionEvent = z.infer<typeof reactionEventSchema>;
export type PartnerChatActionEvent = z.infer<typeof actionEventSchema>;

export interface PartnerChatRef {
  account: string;
  kind: "group" | "dm";
  chat: string;
  thread?: string;
}

export const TIMESTAMP_HEADER = "x-agent-app-request-timestamp";
export const SIGNATURE_HEADER = "x-agent-app-signature";
export const ACCOUNT_HEADER = "x-agent-app-account";

export function signPartnerChat(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`;
}

export function signPartnerChatRequest(
  secret: string,
  timestamp: string,
  account: string,
  path: string,
  rawBody: string,
): string {
  return signPartnerChat(secret, timestamp, `${account}:${path}:${rawBody}`);
}

export function verifyPartnerChat(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowMs: number,
): boolean {
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_S)
    return false;
  return constantTimeEqual(signature ?? "", signPartnerChat(secret, timestamp, rawBody));
}

const inboundSchema = z.discriminatedUnion("type", [eventSchema, actionEventSchema, reactionEventSchema]);

export function parsePartnerChatEvent(raw: unknown) {
  return inboundSchema.safeParse(raw);
}

export function partnerChatRef(c: PartnerChatRef): string {
  return [PARTNER_CHAT, c.account, c.kind, c.chat, ...(c.thread ? [c.thread] : [])].join(":");
}

export function parsePartnerChatRef(ref: string): PartnerChatRef | null {
  const [surface, account, kind, chat, thread, ...rest] = ref.split(":");
  if (
    surface !== PARTNER_CHAT ||
    !account ||
    !chat ||
    !ID.test(account) ||
    !ID.test(chat) ||
    rest.length ||
    (kind !== "group" && kind !== "dm")
  )
    return null;
  return { account, kind, chat, ...(thread ? { thread } : {}) };
}

export function chatContainer(c: Pick<PartnerChatRef, "account" | "kind" | "chat">): string {
  return partnerChatRef({ account: c.account, kind: c.kind, chat: c.chat });
}

export function partnerChatContainer(target: string): string {
  const ref = parsePartnerChatRef(target);
  return ref ? chatContainer(ref) : target;
}

function messageIdSuffix(messageId: string): string {
  return `.${messageId.padStart(MESSAGE_ID_WIDTH, "0")}`;
}

export function partnerChatTs(createdAt: string, messageId: string): string {
  return `${Math.floor(Date.parse(createdAt) / 1000)}${messageIdSuffix(messageId)}`;
}

export function partnerChatMessageId(ref: string): string {
  const dot = ref.indexOf(".");
  return dot < 0 ? ref : ref.slice(dot + 1).replace(/^0+(?=.)/, "");
}

export async function findMessage(
  cache: Pick<SurfaceCache, "readMessages">,
  container: string,
  messageId: string,
  opts: { self?: true; includeDeleted?: true } = {},
): Promise<CachedMessage | undefined> {
  if (!partnerChatMessageIdSchema.safeParse(messageId).success) return undefined;
  const [hit] = await cache.readMessages(container, {
    surface: PARTNER_CHAT,
    tsSuffix: messageIdSuffix(messageId),
    ...(opts.self ? { self: true } : {}),
    ...(opts.includeDeleted ? { includeDeleted: true } : {}),
    limit: 1,
    noFallback: true,
  });
  return hit;
}
