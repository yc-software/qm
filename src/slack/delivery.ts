import { errMessage } from "../util/errors.ts";
import { sleep } from "./util.ts";
import { isExternallyShared, isMpim, type ChannelMeta } from "./identity.ts";

export interface SlackReplyArgs {
  channel: string;
  text: string;
  thread_ts?: string;
  reply_broadcast?: false;
  username?: string;
  icon_emoji?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface BotIdentityOverride {
  username?: string;
  icon_emoji?: string;
}

export function botIdentityFromEnv(env: Record<string, string | undefined>): BotIdentityOverride {
  const username = (env.SLACK_BOT_DISPLAY_NAME ?? "").trim();
  const icon_emoji = (env.SLACK_BOT_ICON_EMOJI ?? "").trim();
  return {
    ...(username ? { username } : {}),
    ...(icon_emoji ? { icon_emoji } : {}),
  };
}

let defaultIdentity: BotIdentityOverride = {};
export function setDefaultBotIdentity(identity: BotIdentityOverride | undefined): void {
  defaultIdentity = identity ?? {};
}

export function botIdentityArgs(): BotIdentityOverride {
  const id = defaultIdentity;
  return {
    ...(id.username ? { username: id.username } : {}),
    ...(id.icon_emoji ? { icon_emoji: id.icon_emoji } : {}),
  };
}

export function slackReplyArgs(
  channel: string,
  text: string,
  threadTs: string | undefined,
  opts: { threadOnly?: boolean; unfurlLinks?: boolean } = {},
): SlackReplyArgs {
  return {
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(threadTs && opts.threadOnly ? { reply_broadcast: false as const } : {}),
    ...(opts.unfurlLinks !== undefined ? { unfurl_links: opts.unfurlLinks, unfurl_media: opts.unfurlLinks } : {}),
    ...botIdentityArgs(),
  };
}

export function scopeSurfaceUrl(webUiPublicUrl: string | undefined, scopeId: string): string | undefined {
  const base = (webUiPublicUrl ?? "").trim().replace(/\/+$/, "");
  if (!base || !scopeId) return undefined;
  const personal = /^personal:([^@]+)@/.exec(scopeId);
  if (personal?.[1] && /^[a-z0-9._-]+$/i.test(personal[1])) return `${base}/projects/${personal[1].toLowerCase()}`;
  const shared = /^(channel|group):(.+)$/.exec(scopeId);
  if (shared?.[1] && shared[2]) return `${base}/projects/${shared[1]}/${encodeURIComponent(shared[2])}`;
  return `${base}/contexts?scope=${encodeURIComponent(scopeId)}`;
}

export function channelSurfaceUrl(webUiPublicUrl: string | undefined, channelId: string): string | undefined {
  return scopeSurfaceUrl(webUiPublicUrl, `channel:${channelId}`);
}

export function channelWelcomeMessage(surfaceUrl: string | undefined): string {
  if (!surfaceUrl) {
    return "Hi! I'm the agent for this channel. Mention me and I'll help out — scheduled jobs, skills, files, and apps I run here are shared with everyone in the channel.";
  }
  return `Hi! I'm the agent for this channel. Everyone here can see and manage what I'm doing — scheduled jobs, skills, files, and apps — on this channel's shared page: ${surfaceUrl}`;
}

export function surfaceHeaderText(
  facts: { agentLabel?: string; modelName?: string },
  projectUrl: string | undefined,
): string | undefined {
  const agent = (facts.agentLabel ?? "").trim();
  const model = (facts.modelName ?? "").trim();
  const url = (projectUrl ?? "").trim();
  const modelText = model ? `${agent ? `${agent} is using` : "Using"} ${model} here.` : "";
  const link = url ? `<${url}|More settings>` : "";
  return [modelText, link].filter(Boolean).join(" ") || undefined;
}

function unwrapSlackLinks(text: string): string {
  return text.replace(/<([^<>|]+)(?:\|[^<>]*)?>/g, "$1");
}

export function headerUpdate(
  existing: { value?: string; creator?: string } | undefined,
  botUserId: string,
  desired: string,
): "set" | "skip" {
  const value = (existing?.value ?? "").trim();
  if (unwrapSlackLinks(value) === unwrapSlackLinks(desired)) return "skip";
  if (!value) return "set";
  return existing?.creator === botUserId ? "set" : "skip";
}

const SURFACE_HEADER_MAX_TRACKED = 1000;

export interface SurfaceHeaderClient {
  conversations: {
    info: (args: { channel: string }) => Promise<{ channel?: ChannelMeta }>;
    setTopic: (args: { channel: string; topic: string }) => Promise<unknown>;
    setPurpose: (args: { channel: string; purpose: string }) => Promise<unknown>;
  };
}

export function createSurfaceHeaderEnsurer(opts: {
  headerFacts(scope: string): Promise<{ agentLabel?: string; modelName: string }>;
  webUiPublicUrl: string | undefined;
  ids: { botUserId: string };
  maxTracked?: number;
}): (client: SurfaceHeaderClient, channel: string, scopeId: string, kind: "dm" | "channel") => void {
  const maxTracked = opts.maxTracked ?? SURFACE_HEADER_MAX_TRACKED;
  const settled = new Map<string, string>();
  const inFlight = new Set<string>();
  const requeued = new Set<string>();
  return function ensure(client, channel, scopeId, kind) {
    if (inFlight.has(channel)) {
      requeued.add(channel);
      return;
    }
    inFlight.add(channel);
    void (async () => {
      try {
        const desired = surfaceHeaderText(
          await opts.headerFacts(scopeId),
          scopeSurfaceUrl(opts.webUiPublicUrl, scopeId),
        );
        if (!desired || settled.get(channel) === desired) return;
        const info = (await client.conversations.info({ channel })).channel;
        if (kind === "channel" && (isExternallyShared(info) || isMpim(info))) return;
        const existing = kind === "dm" ? info?.topic : info?.purpose;
        if (headerUpdate(existing, opts.ids.botUserId, desired) === "set") {
          if (kind === "dm") await client.conversations.setTopic({ channel, topic: desired });
          else await client.conversations.setPurpose({ channel, purpose: desired });
        }
        settled.set(channel, desired);
        capMap(settled, maxTracked);
      } catch (err) {
        console.error("[slack] surface header ensure failed:", errMessage(err));
      } finally {
        inFlight.delete(channel);
        if (requeued.delete(channel)) ensure(client, channel, scopeId, kind);
      }
    })();
  };
}

export async function onBotJoinedChannel(opts: {
  client: {
    chat: { postMessage: (args: SlackReplyArgs) => Promise<unknown> };
    conversations: {
      info: (args: { channel: string }) => Promise<{ channel?: ChannelMeta }>;
      setPurpose: (args: { channel: string; purpose: string }) => Promise<unknown>;
    };
  };
  channel: string | undefined;
  joinerUserId: string | undefined;
  botUserId: string;
  webUiPublicUrl: string | undefined;
  syncDirectory: () => Promise<void>;
  ensureHeader?: (channel: string) => void;
}): Promise<void> {
  const { client, channel, joinerUserId, botUserId, webUiPublicUrl, syncDirectory, ensureHeader } = opts;
  if (!channel || !joinerUserId || joinerUserId !== botUserId) return;
  const surfaceUrl = channelSurfaceUrl(webUiPublicUrl, channel);
  try {
    const info = (await client.conversations.info({ channel })).channel;
    if (!isExternallyShared(info)) {
      await client.chat.postMessage(
        slackReplyArgs(channel, channelWelcomeMessage(surfaceUrl), undefined, { unfurlLinks: false }),
      );
      ensureHeader?.(channel);
    }
  } catch {
    void 0;
  }
  try {
    await syncDirectory();
  } catch {
    void 0;
  }
}

export function encodeDeliveryTarget(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

async function slackUserIdFor(client: any, principalId: string): Promise<string> {
  if (!principalId.includes("@")) return principalId;
  const res = (await client.users.lookupByEmail({ email: principalId })) as { user?: { id?: string } };
  const id = res?.user?.id;
  if (!id) throw new Error(`no Slack member found for ${principalId}`);
  return id;
}

export async function openConversationFor(client: any, principalIds: readonly string[]): Promise<string> {
  const users: string[] = [];
  for (const p of principalIds) users.push(await slackUserIdFor(client, p));
  const opened = (await client.conversations.open({ users: users.join(",") })) as { channel?: { id?: string } };
  const channel = opened?.channel?.id;
  if (!channel) throw new Error("conversations.open returned no channel");
  return channel;
}

export function parseDeliveryTarget(target: string): { channel: string; threadTs?: string } {
  const i = target.indexOf(":");
  if (i < 0) return { channel: target };
  return { channel: target.slice(0, i), threadTs: target.slice(i + 1) };
}

export function deliveryCandidatesFor(
  kind: "dm" | "channel" | "group",
  channel: string,
  replyThreadTs: string | undefined,
  channelName: string | undefined,
): { target: string; label: string }[] | undefined {
  if (kind === "dm") return undefined;
  let wholeLabel = "the whole channel";
  if (kind === "group") wholeLabel = "the group DM";
  else if (channelName) wholeLabel = `#${channelName} (the whole channel)`;
  return [
    { target: encodeDeliveryTarget(channel, replyThreadTs), label: "this thread" },
    { target: encodeDeliveryTarget(channel), label: wholeLabel },
  ];
}

const DELIVERY_MAX_ATTEMPTS = 5;
const DELIVERY_MAX_TRACKED = 1000;

export interface DeliveryTracker {
  givenUp(id: string): boolean;
  posted(id: string): { ackBody?: unknown } | undefined;
  markPosted(id: string, ackBody?: unknown): void;
  recordFailure(id: string): boolean;
  clear(id: string): void;
}

function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function createDeliveryTracker(opts: { maxAttempts?: number; maxTracked?: number } = {}): DeliveryTracker {
  const maxAttempts = opts.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
  const maxTracked = opts.maxTracked ?? DELIVERY_MAX_TRACKED;
  const failures = new Map<string, number>();
  const posted = new Map<string, { ackBody?: unknown }>();
  const dead = new Map<string, true>();
  return {
    givenUp(id) {
      return dead.has(id);
    },
    posted(id) {
      return posted.get(id);
    },
    markPosted(id, ackBody) {
      posted.set(id, ackBody === undefined ? {} : { ackBody });
      while (posted.size > maxTracked) {
        const oldest = posted.keys().next().value;
        if (oldest === undefined) break;
        posted.delete(oldest);
        failures.delete(oldest);
        dead.set(oldest, true);
        capMap(dead, maxTracked);
      }
    },
    recordFailure(id) {
      const count = (failures.get(id) ?? 0) + 1;
      if (count >= maxAttempts) {
        failures.delete(id);
        posted.delete(id);
        dead.set(id, true);
        capMap(dead, maxTracked);
        return true;
      }
      failures.set(id, count);
      capMap(failures, maxTracked);
      return false;
    },
    clear(id) {
      failures.delete(id);
      posted.delete(id);
    },
  };
}

export async function deliverWithRetry(opts: {
  tracker: DeliveryTracker;
  id: string;
  post(): Promise<unknown>;
  ack(body?: unknown): Promise<void>;
  onError(stage: "post" | "ack", err: unknown, gaveUp: boolean): void;
}): Promise<void> {
  const { tracker, id } = opts;
  if (tracker.givenUp(id)) return;
  let postedState = tracker.posted(id);
  if (!postedState) {
    try {
      const ackBody = await opts.post();
      tracker.markPosted(id, ackBody ?? undefined);
      postedState = tracker.posted(id);
    } catch (err) {
      opts.onError("post", err, tracker.recordFailure(id));
      return;
    }
  }
  try {
    await opts.ack(postedState?.ackBody);
    tracker.clear(id);
  } catch (err) {
    opts.onError("ack", err, tracker.recordFailure(id));
  }
}

export interface PostMessageArgs {
  channel: string;
  text?: string;
  thread_ts?: string;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
  [key: string]: unknown;
}
export interface PostVerifyClient {
  chat: { postMessage(args: PostMessageArgs): Promise<unknown> };
  conversations: {
    history(args: {
      channel: string;
      limit: number;
      include_all_metadata: boolean;
      oldest: string;
      inclusive: boolean;
      cursor?: string;
    }): Promise<unknown>;
    replies(args: {
      channel: string;
      ts: string;
      limit: number;
      include_all_metadata: boolean;
      oldest: string;
      inclusive: boolean;
      cursor?: string;
    }): Promise<unknown>;
  };
}

async function findPostedByKey(
  client: PostVerifyClient,
  args: PostMessageArgs,
  idempotencyKey: string,
  oldest: string,
): Promise<{ ts: string; channel: string } | undefined> {
  const channel = args.channel;
  let cursor: string | undefined;
  do {
    const paging = {
      channel,
      limit: 100,
      include_all_metadata: true,
      oldest,
      inclusive: true,
      ...(cursor ? { cursor } : {}),
    };
    const scan = args.thread_ts
      ? await client.conversations.replies({ ...paging, ts: args.thread_ts })
      : await client.conversations.history(paging);
    const page = scan as {
      messages?: Array<{
        ts?: string;
        metadata?: { event_type?: string; event_payload?: { idempotency_key?: string } };
      }>;
      response_metadata?: { next_cursor?: string };
    };
    const hit = (page.messages ?? []).find(
      (m) => m.metadata?.event_type === "qm_delivery" && m.metadata.event_payload?.idempotency_key === idempotencyKey,
    );
    if (hit?.ts) return { ts: String(hit.ts), channel };
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  return undefined;
}

export async function postWithVerify(
  client: PostVerifyClient,
  args: PostMessageArgs,
  idempotencyKey: string,
  opts?: { attempts?: number; verifyFirst?: boolean; verifyOldest?: string },
): Promise<{ ts: string; channel: string }> {
  const maxAttempts = opts?.attempts ?? 3;
  const verifyOldest = opts?.verifyOldest ?? String((Date.now() - 5_000) / 1000);
  args.metadata = { event_type: "qm_delivery", event_payload: { idempotency_key: idempotencyKey } };
  if (opts?.verifyFirst) {
    const found = await findPostedByKey(client, args, idempotencyKey, verifyOldest);
    if (found) return found;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = (await client.chat.postMessage(args)) as { ts?: string; channel?: string };
      return { ts: String(res.ts), channel: String(res.channel ?? args.channel) };
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code === "slack_webapi_platform_error") throw err;
      if (code === "slack_webapi_rate_limited_error") {
        const retryAfter = (err as { retryAfter?: number }).retryAfter ?? 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      let found: { ts: string; channel: string } | undefined;
      try {
        found = await findPostedByKey(client, args, idempotencyKey, verifyOldest);
      } catch {
        throw err;
      }
      if (found) return found;
    }
  }
  throw lastErr;
}
