import { reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { safeChunks, safeClip } from "./safe-cut.ts";
import { sleep } from "../util/async.ts";
import { pinnedPerTenant } from "../tenant.ts";
import { isExternallyShared, isMpim, type ChannelMeta } from "./identity.ts";
import { parseScopeId } from "../types.ts";

export interface BotIdentityOverride {
  username?: string;
  icon_emoji?: string;
}

export interface SlackReplyArgs extends BotIdentityOverride {
  channel: string;
  text: string;
  thread_ts?: string;
  reply_broadcast?: false;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

function botIdentity(username: string | undefined, icon_emoji: string | undefined): BotIdentityOverride {
  return { ...(username ? { username } : {}), ...(icon_emoji ? { icon_emoji } : {}) };
}

export function botIdentityFromEnv(env: Record<string, string | undefined>): BotIdentityOverride {
  return botIdentity(env.SLACK_BOT_DISPLAY_NAME?.trim(), env.SLACK_BOT_ICON_EMOJI?.trim());
}

const defaultIdentity = pinnedPerTenant(() => ({ args: {} as BotIdentityOverride }));
export function setDefaultBotIdentity(identity: BotIdentityOverride | undefined): void {
  defaultIdentity().args = botIdentity(identity?.username, identity?.icon_emoji);
}

export function botIdentityArgs(): BotIdentityOverride {
  return defaultIdentity().args;
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
  const base = webUiPublicUrl ?? "";
  if (!base || !scopeId) return undefined;
  const { kind, ref } = parseScopeId(scopeId);
  const [handle, domain] = ref.split("@");
  if (kind === "personal" && handle && domain !== undefined && /^[a-z0-9._-]+$/i.test(handle))
    return `${base}/projects/${handle.toLowerCase()}`;
  if ((kind === "channel" || kind === "group") && ref) return `${base}/projects/${kind}/${encodeURIComponent(ref)}`;
  return `${base}/contexts?scope=${encodeURIComponent(scopeId)}`;
}

export function channelWelcomeMessage(surfaceUrl: string | undefined): string {
  return `QM here, ready to assist.${surfaceUrl ? ` Access my data and channel settings <${surfaceUrl}|here>.` : ""}`;
}

export function surfaceHeaderText(facts: { modelName?: string }, projectUrl: string | undefined): string | undefined {
  const model = facts.modelName?.trim();
  const url = projectUrl?.trim();
  return [model && `Using ${model} here.`, url && `<${url}|More settings>`].filter(Boolean).join(" ") || undefined;
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
  return !value || existing?.creator === botUserId ? "set" : "skip";
}

const SURFACE_HEADER_MAX_TRACKED = 1000;

export interface SurfaceHeaderClient {
  chat: {
    postMessage: (args: SlackReplyArgs) => Promise<{ ts?: string }>;
    update: (args: { channel: string; ts: string; text: string }) => Promise<unknown>;
    delete: (args: { channel: string; ts: string }) => Promise<unknown>;
  };
  pins: {
    list: (args: { channel: string }) => Promise<{ items?: PinnedItem[] }>;
    add: (args: { channel: string; timestamp: string }) => Promise<unknown>;
    remove: (args: { channel: string; timestamp: string }) => Promise<unknown>;
  };
  conversations: {
    info: (args: { channel: string }) => Promise<{ channel?: ChannelMeta }>;
    setTopic: (args: { channel: string; topic: string }) => Promise<unknown>;
  };
}

export interface PinnedItem {
  message?: { ts?: string; user?: string; text?: string };
}

export function isSurfaceHeaderMessage(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  return !!t && /^(Using .+ here\.)?\s*(<[^<>|]+\|More settings>)?$/.test(t);
}

export function findHeaderPin(
  items: PinnedItem[] | undefined,
  botUserId: string,
): { ts: string; text: string } | undefined {
  const m = items?.find(({ message: m }) => m?.ts && m.user === botUserId && isSurfaceHeaderMessage(m.text))?.message;
  return m?.ts ? { ts: m.ts, text: m.text ?? "" } : undefined;
}

const HEADER_PIN_OFF = "<surface-header-off>";

export function createSurfaceHeaderEnsurer(opts: {
  headerFacts(scope: string): Promise<{ agentLabel?: string; modelName: string }>;
  channelPinEnabled?(scope: string): Promise<boolean>;
  webUiPublicUrl: string | undefined;
  ids: { botUserId: string };
  maxTracked?: number;
}) {
  const maxTracked = opts.maxTracked ?? SURFACE_HEADER_MAX_TRACKED;
  const settled = new Map<string, string>();
  const inFlight = new Set<string>();
  const requeued = new Map<string, { pinNew?: boolean }>();
  return function ensure(
    client: SurfaceHeaderClient,
    channel: string,
    scopeId: string,
    kind: "dm" | "channel",
    ensureOpts?: { pinNew?: boolean },
  ): void {
    if (inFlight.has(channel)) {
      requeued.set(channel, { pinNew: Boolean(requeued.get(channel)?.pinNew || ensureOpts?.pinNew) });
      return;
    }
    inFlight.add(channel);
    void (async () => {
      try {
        const desired = surfaceHeaderText(
          await opts.headerFacts(scopeId),
          scopeSurfaceUrl(opts.webUiPublicUrl, scopeId),
        );
        if (!desired) return;
        const enabled = kind === "dm" || ((await opts.channelPinEnabled?.(scopeId)) ?? false);
        const goal = enabled ? desired : HEADER_PIN_OFF;
        if (settled.get(channel) === goal) return;
        const info = (await client.conversations.info({ channel })).channel;
        if (kind === "dm") {
          if (headerUpdate(info?.topic, opts.ids.botUserId, desired) === "set")
            await client.conversations.setTopic({ channel, topic: desired });
        } else {
          if (isExternallyShared(info) || isMpim(info)) return;
          const pinned = findHeaderPin((await client.pins.list({ channel })).items, opts.ids.botUserId);
          if (!enabled) {
            if (pinned) {
              await client.pins.remove({ channel, timestamp: pinned.ts });
              await client.chat.delete({ channel, ts: pinned.ts });
            }
          } else if (pinned) {
            if (unwrapSlackLinks(pinned.text) !== unwrapSlackLinks(desired))
              await client.chat.update({ channel, ts: pinned.ts, text: desired });
          } else if (ensureOpts?.pinNew) {
            const posted = await client.chat.postMessage(
              slackReplyArgs(channel, desired, undefined, { unfurlLinks: false }),
            );
            if (posted.ts) await client.pins.add({ channel, timestamp: posted.ts });
          }
        }
        settled.set(channel, goal);
        while (settled.size > maxTracked) settled.delete(settled.keys().next().value!);
      } catch (err) {
        reportFailure("slack: surface header ensure", err, channel);
      } finally {
        inFlight.delete(channel);
        const again = requeued.get(channel);
        if (again) {
          requeued.delete(channel);
          ensure(client, channel, scopeId, kind, again);
        }
      }
    })();
  };
}

export async function onBotJoinedChannel(opts: {
  client: {
    chat: { postMessage: (args: SlackReplyArgs) => Promise<unknown> };
    conversations: {
      info: (args: { channel: string }) => Promise<{ channel?: ChannelMeta }>;
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
  const surfaceUrl = scopeSurfaceUrl(webUiPublicUrl, `channel:${channel}`);
  try {
    const info = (await client.conversations.info({ channel })).channel;
    if (!isExternallyShared(info)) {
      await client.chat.postMessage(
        slackReplyArgs(channel, channelWelcomeMessage(surfaceUrl), undefined, { unfurlLinks: false }),
      );
      ensureHeader?.(channel);
    }
  } catch (err) {
    swallow("slack: channel join welcome", err);
  }
  await syncDirectory().catch(swallowAs("slack: directory sync after channel join", undefined));
}

export function encodeDeliveryTarget(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

export async function openConversationFor(client: any, principalIds: readonly string[]): Promise<string> {
  const users: string[] = [];
  for (const p of principalIds) {
    const id = p.includes("@") ? (await client.users.lookupByEmail({ email: p }))?.user?.id : p;
    if (!id) throw new Error(`no Slack member found for ${p}`);
    users.push(id);
  }
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

type DeliveryMetadata = { event_type: string; event_payload: Record<string, unknown> };

export interface PostMessageArgs {
  channel: string;
  text?: string;
  thread_ts?: string;
  metadata?: DeliveryMetadata;
  [key: string]: unknown;
}

export function deliveryMetadata(idempotencyKey: string): DeliveryMetadata {
  return { event_type: "qm_delivery", event_payload: { idempotency_key: idempotencyKey } };
}
type ScanArgs = {
  channel: string;
  limit: number;
  include_all_metadata: boolean;
  oldest: string;
  inclusive: boolean;
  cursor?: string;
};

export interface PostVerifyClient {
  chat: { postMessage(args: PostMessageArgs): Promise<unknown> };
  conversations: {
    history(args: ScanArgs): Promise<unknown>;
    replies(args: ScanArgs & { ts: string }): Promise<unknown>;
  };
}

export async function findPostedByKey(
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
    const page = (await (args.thread_ts
      ? client.conversations.replies({ ...paging, ts: args.thread_ts })
      : client.conversations.history(paging))) as {
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

export function statusPlaceholderKey(runId: string): string {
  return `status:run:${runId}`;
}

export function recoveryVerifyOldest(createdAt: number | undefined, editRef: string | undefined): string | undefined {
  const bounds: number[] = [];
  if (typeof createdAt === "number") bounds.push(createdAt / 1000 - 60);
  const editRefSec = Number(editRef);
  if (editRef && Number.isFinite(editRefSec)) bounds.push(editRefSec - 5);
  return bounds.length ? String(Math.min(...bounds)) : undefined;
}

export const SLACK_TEXT_LIMIT = 40000;

export const SLACK_POST_SPLIT_LIMIT = 3_800;

type PostedPart = { ts: string | undefined; channel: string; reused?: boolean; text: string };

export async function postWithVerify(
  client: PostVerifyClient,
  args: PostMessageArgs,
  idempotencyKey: string,
  opts?: { attempts?: number; verifyFirst?: boolean; verifyOldest?: string; verifyBestEffort?: boolean },
): Promise<{ ts: string | undefined; channel: string; reused?: boolean; parts?: PostedPart[] }> {
  const fullText = typeof args.text === "string" ? args.text : "";
  const batches: PostMessageArgs[] = [];
  if (Array.isArray(args.blocks) && args.blocks.length > 50) {
    for (let offset = 0; offset < args.blocks.length; offset += 50) {
      const blocks = args.blocks.slice(offset, offset + 50);
      const text = blocks
        .filter((block) => block.type === "section" && typeof block.text?.text === "string")
        .map((block) => block.text.text)
        .join("\n");
      batches.push({ ...args, blocks, text });
    }
  } else if (!args.blocks && fullText.length > SLACK_POST_SPLIT_LIMIT) {
    batches.push(...safeChunks(fullText, SLACK_POST_SPLIT_LIMIT).map((text) => ({ ...args, text })));
  }
  if (batches.length) {
    const parts: PostedPart[] = [];
    for (const [i, batch] of batches.entries()) {
      const res = await postWithVerify(client, batch, i === 0 ? idempotencyKey : `${idempotencyKey}#p${i + 1}`, {
        ...opts,
        verifyFirst: true,
        verifyBestEffort: !opts?.verifyFirst,
      });
      const { ts, channel, reused } = res;
      parts.push({ ts, channel, ...(reused !== undefined ? { reused } : {}), text: batch.text ?? "" });
    }
    return {
      ts: parts[0]!.ts,
      channel: parts[0]!.channel,
      ...(parts.every((p) => p.reused) ? { reused: true } : {}),
      parts,
    };
  }
  if (args.blocks && fullText.length > SLACK_TEXT_LIMIT - 1_000) {
    args.text = safeClip(fullText, SLACK_TEXT_LIMIT - 1_000);
  }
  const maxAttempts = opts?.attempts ?? 3;
  const verifyOldest = opts?.verifyOldest ?? String((Date.now() - 5_000) / 1000);
  args.metadata = deliveryMetadata(idempotencyKey);
  if (opts?.verifyFirst) {
    const verify = findPostedByKey(client, args, idempotencyKey, verifyOldest);
    const found = await (opts.verifyBestEffort ? verify.catch(swallowAs("slack: part verify", null)) : verify);
    if (found) return { ...found, reused: true };
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = (await client.chat.postMessage(args)) as { ts?: string; channel?: string };
      return { ts: res.ts === undefined ? undefined : String(res.ts), channel: String(res.channel ?? args.channel) };
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code === "slack_webapi_platform_error") throw err;
      const limited = code === "slack_webapi_rate_limited_error";
      if (limited) await sleep(((err as { retryAfter?: number }).retryAfter ?? 1) * 1000);
      const found = await findPostedByKey(client, args, idempotencyKey, verifyOldest).catch(() => {
        if (limited) return undefined;
        throw err;
      });
      if (found) return limited ? { ...found, reused: true } : found;
    }
  }
  throw lastErr;
}
