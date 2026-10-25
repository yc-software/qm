import { z } from "zod";
import { canonicalPayload } from "../../plugins/chassis/src/source-auth-sign.ts";
import { isStrongSigningSecret, SOURCE_AUTH_REPLAY_WINDOW_MS, verifySignature } from "../auth/source-auth.ts";
import type { ChatSurfaceAdapter, InboundMessage, InboundOutcome } from "./adapter.ts";

const RESERVED_SURFACES = new Set([
  "slack",
  "slack-account",
  "external-slack",
  "web",
  "principal",
  "group",
  "dm",
  "cron",
  "webhook",
  "monitor",
  "swarm",
  "loop",
  "inbox",
  "agent",
  "unknown",
]);
const POST_TIMEOUT_MS = 15_000;

const id = z
  .union([z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform(String);

const userSchema = z.object({
  id,
  email: z.string().max(320).optional(),
  name: z.string().max(200).optional(),
  guest: z.boolean().optional(),
  bot: z.boolean().optional(),
  timezone: z.string().max(64).optional(),
});

const messageEventSchema = z.object({
  type: z.literal("message"),
  chat: z.object({
    id,
    kind: z.enum(["dm", "group", "channel"]),
    name: z.string().max(200).optional(),
    members: z.array(userSchema).max(500).optional(),
  }),
  message: z.object({
    id,
    thread_id: id.nullish(),
    text: z.string().max(100_000),
    mentions_bot: z.boolean().optional(),
    thread_has_bot: z.boolean().optional(),
  }),
  author: userSchema,
});

const configSchema = z.object({
  surface: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .refine((surface) => !RESERVED_SURFACES.has(surface), { message: "is reserved" }),
  account: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .default("default"),
  label: z.string().min(1).max(60),
  apiUrl: z.url().refine((url) => /^https?:\/\//.test(url), { message: "must be http(s)" }),
  apiToken: z.string().min(16),
  signingSecret: z.string().refine(isStrongSigningSecret, { message: "must be at least 32 characters" }),
  internalEmailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
});

export type HttpChatConfig = z.output<typeof configSchema>;

export function httpChatConfigsFromEnv(env: Record<string, string | undefined>): HttpChatConfig[] {
  const raw = env.HTTP_CHAT_SURFACES?.trim();
  if (!raw) return [];
  const parsed = z.array(configSchema).safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error(
      `HTTP_CHAT_SURFACES is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function createHttpChatAdapter(
  config: HttpChatConfig,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): ChatSurfaceAdapter {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const apiBase = config.apiUrl.replace(/\/+$/, "");

  const internalDomains = new Set(config.internalEmailDomains);
  const internal = (u: z.output<typeof userSchema>): boolean =>
    u.guest !== true && internalDomains.has(u.email?.trim().toLowerCase().split("@")[1] ?? "");

  function normalize(event: z.output<typeof messageEventSchema>): InboundMessage {
    const user = (u: z.output<typeof userSchema>) => ({
      id: u.id,
      ...(u.email ? { email: u.email } : {}),
      ...(u.name ? { displayName: u.name } : {}),
      ...(internal(u) ? {} : { guest: true }),
      ...(u.bot ? { bot: true } : {}),
      ...(u.timezone ? { timezone: u.timezone } : {}),
    });
    return {
      messageId: event.message.id,
      kind: event.chat.kind,
      container: event.chat.id,
      ...(event.chat.name ? { containerName: event.chat.name } : {}),
      ...(event.message.thread_id ? { thread: event.message.thread_id } : {}),
      author: user(event.author),
      ...(event.chat.members ? { members: event.chat.members.map(user) } : {}),
      text: event.message.text,
      mentionsSelf: event.message.mentions_bot === true,
      threadEngaged: event.message.thread_has_bot === true,
    };
  }

  return {
    surface: config.surface,
    account: config.account,
    label: config.label,
    async receive({ headers, pathWithQuery, rawBody }): Promise<InboundOutcome> {
      const verified = verifySignature(
        config.signingSecret,
        {
          signature: header(headers["x-signature"]),
          timestamp: Number(header(headers["x-timestamp"])),
          body: canonicalPayload("POST", pathWithQuery, rawBody),
        },
        now(),
        SOURCE_AUTH_REPLAY_WINDOW_MS,
      );
      if (!verified.ok) return { status: 401, reason: verified.reason };
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return { status: 400, reason: "invalid JSON body" };
      }
      if (body && typeof body === "object" && (body as { type?: unknown }).type !== "message")
        return { status: 200, messages: [] };
      const event = messageEventSchema.safeParse(body);
      if (!event.success) return { status: 400, reason: event.error.issues[0]?.message ?? "invalid event" };
      if (event.data.chat.kind !== "dm") return { status: 200, messages: [] };
      return { status: 200, messages: [normalize(event.data)] };
    },
    async post(target, message) {
      const response = await doFetch(`${apiBase}/chats/${encodeURIComponent(target.container)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          text: message.text,
          ...(target.thread ? { thread_id: target.thread } : {}),
          idempotency_key: message.idempotencyKey,
        }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${config.surface} post failed: HTTP ${response.status}`);
      const out = (await response.json().catch(() => ({}))) as { id?: unknown };
      return { messageId: String(out.id ?? "") };
    },
  };
}
