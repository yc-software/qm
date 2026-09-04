import { botIdentityFromEnv } from "./delivery.ts";

export const NO_RETRY = { retryConfig: { retries: 0 } } as const;

export interface SlackPluginConfig {
  botToken: string;
  appToken?: string;
  apiUrl?: string;
  eventsMode?: "socket" | "http";
  signingSecret?: string;
  eventsPort?: number;
  userToken?: string;
  copilotBotToken?: string;
  webUiPublicUrl?: string;
  identityEmail?: string;
  logLevel?: string;
  userSnapshotTtlMs?: number;
  channelMembersTtlMs?: number;
  maxPrivateChannels?: number;
  recentMessages?: number;
  userCacheTtlMs?: number;
  botIdentity?: { username?: string; icon_emoji?: string };
  devIntrospection?: { port: number };
}

export function parseAckEmoji(raw: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const name = part.replace(/^:+/, "").replace(/:+$/, "").trim().toLowerCase();
    if (!name || seen.has(name) || !/^[a-z0-9_+-]+$/.test(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function slackPluginConfigFromEnv(env: Record<string, string | undefined>): SlackPluginConfig | null {
  const eventsMode = env.SLACK_EVENTS_MODE?.trim() === "http" ? "http" : "socket";
  if (!env.SLACK_BOT_TOKEN) return null;
  if (eventsMode === "socket" && !env.SLACK_APP_TOKEN) return null;
  if (eventsMode === "http" && !env.SLACK_SIGNING_SECRET) return null;
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const opt = <K extends keyof SlackPluginConfig>(
    key: K,
    value: SlackPluginConfig[K] | undefined,
  ): Partial<SlackPluginConfig> => (value === undefined ? {} : ({ [key]: value } as Partial<SlackPluginConfig>));
  return {
    botToken: env.SLACK_BOT_TOKEN,
    ...opt("appToken", env.SLACK_APP_TOKEN),
    ...opt("apiUrl", env.SLACK_API_URL),
    ...(eventsMode === "http" ? { eventsMode } : {}),
    ...opt("signingSecret", env.SLACK_SIGNING_SECRET),
    ...opt("eventsPort", num(env.SLACK_EVENTS_PORT)),
    ...opt("userToken", env.SLACK_USER_TOKEN),
    ...opt("copilotBotToken", env.SLACK_COPILOT_BOT_TOKEN),
    ...opt("webUiPublicUrl", env.WEB_UI_PUBLIC_URL),
    ...opt("identityEmail", env.SLACK_IDENTITY_EMAIL),
    ...opt("logLevel", env.SLACK_LOG_LEVEL),
    ...opt("userSnapshotTtlMs", num(env.SLACK_USER_SNAPSHOT_TTL_MS)),
    ...opt("channelMembersTtlMs", num(env.SLACK_CHANNEL_MEMBERS_TTL_MS)),
    ...opt("maxPrivateChannels", num(env.SLACK_MAX_PRIVATE_CHANNELS)),
    ...opt("recentMessages", num(env.SLACK_RECENT_MESSAGES)),
    ...opt("userCacheTtlMs", num(env.SLACK_USER_CACHE_TTL_MS)),
    ...(() => {
      const identity = botIdentityFromEnv(env);
      return Object.keys(identity).length ? { botIdentity: identity } : {};
    })(),
    ...(env.DEV_INTROSPECTION === "1" ? { devIntrospection: { port: num(env.DEV_HEALTH_PORT) ?? 0 } } : {}),
  };
}

export function normalizeSlackApiUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? `${trimmed}/` : `${trimmed}/api/`;
}
