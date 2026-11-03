import { z } from "zod";
import { hmacHex } from "../../webhooks/verifiers.ts";
import { constantTimeEqual } from "../../util/crypto.ts";
import type { CachedMessage, SurfaceCache } from "../../surface-cache/types.ts";

const MAX_CLOCK_SKEW_S = 300;
const MESSAGE_ID_WIDTH = 20;

const id = z.string().regex(/^[A-Za-z0-9_-]+$/);
const user = z.object({
  id,
  email: z.string().optional(),
  name: z.string().optional(),
  bot: z.boolean().optional(),
});
const eventSchema = z.object({
  event_id: z.string().min(1),
  type: z.enum(["message.created", "message.updated", "message.deleted"]),
  account: id,
  chat: z.object({ id, kind: z.enum(["group", "dm"]), name: z.string().optional(), members: z.array(user) }),
  thread_id: id.nullish(),
  message: z.object({
    id: z.string().regex(/^\d{1,20}$/),
    user,
    body: z.string(),
    mentions_agent: z.boolean().default(false),
    created_at: z.iso.datetime({ offset: true }),
  }),
});

export type PartnerChatUser = z.infer<typeof user>;

export interface PartnerChatRef {
  account: string;
  kind: "group" | "dm";
  chat: string;
  thread?: string;
}

export function signPartnerChat(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
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

export function parsePartnerChatEvent(raw: unknown) {
  return eventSchema.safeParse(raw);
}

export function partnerChatRef(c: PartnerChatRef): string {
  return ["partner-chat", c.account, c.kind, c.chat, ...(c.thread ? [c.thread] : [])].join(":");
}

export function parsePartnerChatRef(ref: string): PartnerChatRef | null {
  const [surface, account, kind, chat, thread, ...rest] = ref.split(":");
  if (surface !== "partner-chat" || !account || !chat || rest.length || (kind !== "group" && kind !== "dm"))
    return null;
  return { account, kind, chat, ...(thread ? { thread } : {}) };
}

export function partnerChatContainer(target: string): string {
  const ref = parsePartnerChatRef(target);
  return ref ? partnerChatRef({ account: ref.account, kind: ref.kind, chat: ref.chat }) : target;
}

export function partnerChatTs(createdAt: string, messageId: string): string {
  return `${Math.floor(Date.parse(createdAt) / 1000)}.${messageId.padStart(MESSAGE_ID_WIDTH, "0")}`;
}

export function partnerChatMessageId(ref: string): string {
  const dot = ref.indexOf(".");
  return dot < 0 ? ref : ref.slice(dot + 1).replace(/^0+(?=.)/, "");
}

const MESSAGE_SCAN_PAGE = 500;

export async function findMessage(
  cache: Pick<SurfaceCache, "readMessages">,
  container: string,
  messageId: string,
  opts: { self?: true; before?: string } = {},
): Promise<CachedMessage | undefined> {
  let before = opts.before;
  for (;;) {
    const page = await cache.readMessages(container, {
      surface: "partner-chat",
      ...(opts.self ? { self: true } : {}),
      ...(before ? { before } : {}),
      limit: MESSAGE_SCAN_PAGE,
      noFallback: true,
    });
    const hit = page.find((m) => partnerChatMessageId(m.ts) === messageId);
    if (hit || page.length < MESSAGE_SCAN_PAGE) return hit;
    before = page[0]!.ts;
  }
}
