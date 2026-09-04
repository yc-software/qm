import { createHmac } from "node:crypto";
import { createKeyedQueue } from "../../src/util/async.ts";
import { sleep } from "./slack.ts";
import slackManifest from "../../src/slack/manifest.json" with { type: "json" };
import qaManifest from "./qa-driver.manifest.json" with { type: "json" };

const ARGA_API_BASE = process.env.ARGA_API_BASE ?? "https://api.argalabs.com";

const BOT_SCOPES = slackManifest.oauth_config.scopes.bot;
const USER_SCOPES = [...qaManifest.oauth_config.scopes.user, "channels:manage"];

export interface TwinSession {
  runId: string;
  baseUrl: string;
  adminUrl: string;
  proxyToken: string;
  botToken: string;
  signingSecret: string;
}

export interface SeededUser {
  token: string;
}

async function argaFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${ARGA_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`arga ${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

export async function provisionSlackTwin(apiKey: string, ttlMinutes: number): Promise<TwinSession> {
  const { run_id } = await argaFetch(apiKey, "/validate/twins/provision", {
    method: "POST",
    body: JSON.stringify({ twins: ["slack"], ttl_minutes: ttlMinutes }),
  });
  const deadline = Date.now() + 6 * 60_000;
  for (;;) {
    const status = await argaFetch(apiKey, `/validate/twins/provision/${run_id}/status`);
    if (status.status === "ready") {
      const slack = status.twins?.slack;
      if (!slack?.base_url || !slack?.admin_url)
        throw new Error(`twin ready but no slack urls: ${JSON.stringify(status).slice(0, 400)}`);
      const session: TwinSession = {
        runId: run_id,
        baseUrl: slack.base_url,
        adminUrl: slack.admin_url,
        proxyToken: status.proxy_token ?? "",
        botToken: slack.env_vars?.SLACK_BOT_TOKEN ?? "",
        signingSecret: slack.env_vars?.SLACK_SIGNING_SECRET ?? "",
      };
      const admin = new TwinAdmin(session.adminUrl, session.proxyToken);
      const config = await admin.getConfig();
      session.signingSecret = config?.event_delivery?.signing_secret ?? session.signingSecret;
      if (!session.botToken) session.botToken = (config?.tokens ?? []).find((t: any) => t.is_bot)?.token ?? "";
      if (!session.botToken || !session.signingSecret)
        throw new Error("twin config missing bot token or signing secret");
      return session;
    }
    if (status.status === "failed")
      throw new Error(`twin provisioning failed: ${JSON.stringify(status.error).slice(0, 400)}`);
    if (Date.now() > deadline) throw new Error(`twin provisioning timed out (last status: ${status.status})`);
    await sleep(5000);
  }
}

export async function teardownTwin(apiKey: string, runId: string): Promise<void> {
  await argaFetch(apiKey, `/validate/twins/provision/${runId}/teardown`, { method: "POST" });
}

export class TwinAdmin {
  readonly adminUrl: string;
  readonly proxyToken: string;

  constructor(adminUrl: string, proxyToken: string) {
    this.adminUrl = adminUrl;
    this.proxyToken = proxyToken;
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.adminUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.proxyToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`twin-admin ${method} ${path} → ${res.status}: ${JSON.stringify(parsed).slice(0, 400)}`);
    return parsed;
  }

  getConfig(): Promise<any> {
    return this.req("GET", "/admin/config");
  }

  patchConfig(partial: Record<string, unknown>): Promise<any> {
    return this.req("PATCH", "/admin/config", partial);
  }

  listEvents(): Promise<{ events: Array<{ id: string; envelope: Record<string, any> }> }> {
    return this.req("GET", "/admin/events");
  }
}

export async function seedTwinUsers(
  admin: TwinAdmin,
  session: TwinSession,
  names: string[],
): Promise<Map<string, SeededUser>> {
  const config = await admin.getConfig();
  const users = [...(config.users ?? [])];
  const tokens = [...(config.tokens ?? [])].map((t: any) =>
    t.token === session.botToken ? { ...t, scopes: BOT_SCOPES } : t,
  );
  const seeded = new Map<string, SeededUser>();
  const suffix = Math.random().toString(36).slice(2, 8);
  for (const raw of names) {
    const name = raw.toLowerCase();
    const userId = `UE2E${name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8)}`;
    const token = `xoxp-e2e-${name}-${suffix}`;
    users.push({
      id: userId,
      name: `e2e-${name}`,
      real_name: `E2E ${name[0]!.toUpperCase()}${name.slice(1)}`,
      is_bot: false,
    });
    tokens.push({ token, user_id: userId, scopes: USER_SCOPES, is_bot: false });
    seeded.set(name, { token });
  }
  await admin.patchConfig({ users, tokens });
  return seeded;
}

interface PumpOptions {
  admin: TwinAdmin;
  signingSecret: string;
  targetUrl: string;
  botUserId: string;
  pollMs?: number;
}

function channelTypeOf(channelId: string): string {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}

function shouldSynthesizeMention(event: Record<string, any>, botUserId: string): boolean {
  return (
    event.type === "message" &&
    !event.subtype &&
    event.channel_type !== "im" &&
    typeof event.text === "string" &&
    event.text.includes(`<@${botUserId}>`) &&
    event.user !== botUserId
  );
}

async function deliver(opts: PumpOptions, envelope: Record<string, any>): Promise<void> {
  const body = JSON.stringify(envelope);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", opts.signingSecret).update(`v0:${ts}:${body}`).digest("hex")}`;
      const res = await fetch(opts.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": signature,
          ...(attempt > 1 ? { "X-Slack-Retry-Num": String(attempt - 1), "X-Slack-Retry-Reason": "http_error" } : {}),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    } catch {
      void 0;
    }
    await sleep(attempt * 500);
  }
  console.error(`  ⚠️  event pump: dropped ${envelope.event_id} (${envelope.event?.type}) after 4 delivery attempts`);
}

function mentionEnvelopeFor(envelope: Record<string, any>): Record<string, any> | null {
  const event = envelope.event ?? {};
  if (event.type !== "message" || event.subtype) return null;
  return {
    ...envelope,
    event_id: `${envelope.event_id}M`,
    event: {
      type: "app_mention",
      user: event.user,
      text: event.text,
      ts: event.ts,
      channel: event.channel,
      event_ts: event.event_ts ?? event.ts,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...(event.files ? { files: event.files } : {}),
    },
  };
}

export async function redeliverChannelMessage(
  opts: Omit<PumpOptions, "pollMs"> & { channel: string; ts: string },
): Promise<boolean> {
  const { events } = await opts.admin.listEvents();
  const recorded = events.find(
    (e) =>
      e.envelope?.event?.type === "message" &&
      e.envelope.event.channel === opts.channel &&
      e.envelope.event.ts === opts.ts,
  );
  if (!recorded) return false;
  const envelope = { ...recorded.envelope, event: { ...recorded.envelope.event } };
  if (!envelope.event.channel_type) envelope.event.channel_type = channelTypeOf(String(envelope.event.channel));
  await deliver(opts, envelope);
  const mention = shouldSynthesizeMention(envelope.event, opts.botUserId) ? mentionEnvelopeFor(envelope) : null;
  if (mention) await deliver(opts, mention);
  return true;
}

export interface EventPump {
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startEventPump(opts: PumpOptions): EventPump {
  const seen = new Set<string>();
  const perChannel = createKeyedQueue<string>();
  let primed = false;
  let stopped = false;

  const cycle = async (): Promise<void> => {
    const { events } = await opts.admin.listEvents();
    if (!primed) {
      for (const e of events) seen.add(e.id);
      primed = true;
      return;
    }
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const envelope = { ...e.envelope };
      const event = { ...envelope.event };
      if (event.channel && !event.channel_type) event.channel_type = channelTypeOf(String(event.channel));
      envelope.event = event;
      const channelKey = String(event.channel ?? "global");
      void perChannel(channelKey, async () => {
        await deliver(opts, envelope);
        if (shouldSynthesizeMention(event, opts.botUserId)) {
          const mention = mentionEnvelopeFor(envelope);
          if (mention) await deliver(opts, mention);
        }
      });
    }
  };

  const logPollFailure = (err: Error): void => console.error(`  ⚠️  event pump poll failed: ${err.message}`);
  const ready = (async () => {
    while (!primed && !stopped) {
      try {
        await cycle();
      } catch (err) {
        logPollFailure(err as Error);
        await sleep(1000);
      }
    }
  })();
  const loop = (async () => {
    await ready;
    while (!stopped) {
      await sleep(opts.pollMs ?? 750);
      await cycle().catch(logPollFailure);
    }
  })();

  return {
    ready,
    async stop() {
      stopped = true;
      await loop.catch(() => {});
    },
  };
}
