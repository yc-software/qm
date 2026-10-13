import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SlackPost {
  method: string;
  channel: string;
  text?: string;
  thread_ts?: string;
  ts: string;
  metadata?: unknown;
  blocks?: unknown;
}

export interface SlackCall {
  method: string;
  args: Record<string, unknown>;
}

export interface FakeSlack {
  url: string;
  calls: SlackCall[];
  posts: SlackPost[];
  channels: Map<string, { id: string; name: string; is_archived?: boolean; is_private?: boolean; is_im?: boolean }>;
  users: Map<string, { id: string; name: string; email: string }>;
  dmFor: Map<string, string>;
  errorFor: Map<string, string>;
  failNext: Array<{ method: string; error: string; status?: number }>;
  history: Map<string, Array<{ user: string; text: string; ts: string; thread_ts?: string }>>;
  holdPosts: Promise<void> | null;
  close(): Promise<void>;
}

async function parseArgs(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const params = new URLSearchParams(raw);
  const args: Record<string, unknown> = {};
  for (const [key, value] of params) args[key] = value;
  return args;
}

export async function startFakeSlack(): Promise<FakeSlack> {
  let tsCounter = 0;
  const fake: FakeSlack = {
    url: "",
    calls: [],
    posts: [],
    channels: new Map(),
    users: new Map(),
    dmFor: new Map(),
    errorFor: new Map(),
    failNext: [],
    history: new Map(),
    holdPosts: null,
    close: async () => {},
  };
  const nextTs = (): string => `${Math.floor(Date.now() / 1000)}.${String(++tsCounter).padStart(6, "0")}`;
  const member = (id: string) => {
    const user = fake.users.get(id);
    return user
      ? {
          id: user.id,
          team_id: "TJOURNEY",
          name: user.name,
          real_name: user.name,
          is_bot: false,
          profile: { email: user.email, display_name: user.name, real_name: user.name },
        }
      : undefined;
  };
  const handle = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const forced = fake.errorFor.get(method);
    if (forced) return { ok: false, error: forced };
    switch (method) {
      case "auth.test":
        return {
          ok: true,
          team_id: "TJOURNEY",
          user_id: "UQMBOT",
          bot_id: "BQMBOT",
          user: "qm",
          team: "Journey",
          url: "https://journey.slack.com/",
        };
      case "emoji.list":
        return { ok: true, emoji: {} };
      case "users.list":
        return { ok: true, members: [...fake.users.keys()].map(member), response_metadata: { next_cursor: "" } };
      case "users.info": {
        const user = member(String(args.user));
        return user ? { ok: true, user } : { ok: false, error: "user_not_found" };
      }
      case "users.lookupByEmail": {
        const user = [...fake.users.values()].find((u) => u.email === args.email);
        return user ? { ok: true, user: member(user.id) } : { ok: false, error: "users_not_found" };
      }
      case "conversations.list":
        return {
          ok: true,
          channels: [...fake.channels.values()].map((c) => ({ is_member: true, is_private: false, ...c })),
          response_metadata: { next_cursor: "" },
        };
      case "conversations.info": {
        const channel = fake.channels.get(String(args.channel));
        return channel
          ? { ok: true, channel: { is_member: true, is_private: false, ...channel } }
          : { ok: false, error: "channel_not_found" };
      }
      case "conversations.members":
        return { ok: true, members: [...fake.users.keys(), "UQMBOT"], response_metadata: { next_cursor: "" } };
      case "conversations.open": {
        const users = String(args.users ?? "").split(",");
        const dm = fake.dmFor.get(users[0]!);
        return dm ? { ok: true, channel: { id: dm } } : { ok: false, error: "user_not_found" };
      }
      case "conversations.history":
      case "conversations.replies": {
        const channel = String(args.channel);
        const seeded = (fake.history.get(channel) ?? []).map((m) => ({ type: "message", ...m }));
        const posted = fake.posts
          .filter((p) => p.channel === channel)
          .filter((p) => (method === "conversations.replies" ? p.ts === args.ts || p.thread_ts === args.ts : true))
          .map((p) => ({
            type: "message",
            user: "UQMBOT",
            bot_id: "BQMBOT",
            text: p.text,
            ts: p.ts,
            ...(p.thread_ts ? { thread_ts: p.thread_ts } : {}),
            metadata: p.metadata,
          }));
        const messages = [...seeded, ...posted]
          .filter((m) =>
            method === "conversations.replies"
              ? m.ts === args.ts || m.thread_ts === args.ts
              : !m.thread_ts || m.thread_ts === m.ts,
          )
          .sort((a, b) => Number(b.ts) - Number(a.ts))
          .slice(0, Number(args.limit ?? 100));
        return { ok: true, messages, has_more: false };
      }
      case "chat.postMessage": {
        if (fake.holdPosts) await fake.holdPosts;
        const channelId = String(args.channel);
        const channel = fake.channels.get(channelId);
        if (!channel) return { ok: false, error: "channel_not_found" };
        if (channel.is_archived) return { ok: false, error: "is_archived" };
        const post: SlackPost = {
          method,
          channel: channelId,
          text: typeof args.text === "string" ? args.text : undefined,
          thread_ts: typeof args.thread_ts === "string" ? args.thread_ts : undefined,
          ts: nextTs(),
          metadata: typeof args.metadata === "string" ? JSON.parse(args.metadata) : args.metadata,
          blocks: typeof args.blocks === "string" ? JSON.parse(args.blocks) : args.blocks,
        };
        fake.posts.push(post);
        return { ok: true, channel: channelId, ts: post.ts, message: { text: post.text, ts: post.ts } };
      }
      case "chat.update": {
        const post = fake.posts.find((p) => p.channel === args.channel && p.ts === args.ts);
        if (post) {
          post.text = typeof args.text === "string" ? args.text : post.text;
          post.blocks = typeof args.blocks === "string" ? JSON.parse(args.blocks) : args.blocks;
        }
        return { ok: true, channel: args.channel, ts: args.ts };
      }
      case "chat.delete":
      case "reactions.add":
      case "reactions.remove":
      case "pins.add":
      case "pins.remove":
        return { ok: true };
      case "reactions.get":
        return { ok: true, message: { reactions: [] } };
      case "pins.list":
        return { ok: true, items: [] };
      case "bots.info":
        return { ok: true, bot: { id: "BQMBOT", user_id: "UQMBOT", name: "qm" } };
      default:
        return { ok: false, error: "unknown_method" };
    }
  };
  const server: Server = createServer(async (req, res) => {
    const method = (req.url ?? "/")
      .split("?")[0]!
      .replace(/^\/api\//, "")
      .replace(/^\//, "");
    const args =
      req.method === "POST" ? await parseArgs(req) : Object.fromEntries(new URL(req.url!, "http://x").searchParams);
    fake.calls.push({ method, args });
    const failAt = fake.failNext.findIndex((f) => f.method === method);
    if (failAt >= 0) {
      const [fail] = fake.failNext.splice(failAt, 1);
      res.writeHead(fail!.status ?? 200, {
        "content-type": "application/json",
        ...(fail!.status === 429 ? { "retry-after": "1" } : {}),
      });
      res.end(JSON.stringify({ ok: false, error: fail!.error }));
      return;
    }
    const body = await handle(method, args);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  fake.close = () =>
    new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return fake;
}
