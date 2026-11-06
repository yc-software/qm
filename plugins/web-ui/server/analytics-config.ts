import { posthogConfig } from "../../chassis/src/posthog-config.ts";

export function productAnalyticsConfig(env: NodeJS.ProcessEnv): {
  analytics?: { apiKey: string; host: string; sessionRecording?: Record<string, unknown> };
  origins: string[];
} {
  const config = posthogConfig(env.POSTHOG_CONFIG);
  if (!config) return { origins: [] };
  const { host } = config;
  const [region, ...domain] = new URL(host).hostname.split(".");
  const remoteConfigOrigin =
    domain.join(".") === "i.posthog.com" ? `https://${region}-assets.i.posthog.com` : undefined;
  return {
    analytics: config,
    origins: [host, ...(remoteConfigOrigin ? [remoteConfigOrigin] : [])],
  };
}
