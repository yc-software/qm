import { posthogConfig } from "../../chassis/src/posthog-config.ts";

export function productAnalyticsConfig(env: NodeJS.ProcessEnv): {
  analytics?: { apiKey: string; host: string; options?: Record<string, unknown> };
  origins: string[];
} {
  const config = posthogConfig(env.POSTHOG_CONFIG);
  if (!config) return { origins: [] };
  const { apiKey, host, options } = config;
  const [region, ...domain] = new URL(host).hostname.split(".");
  const remoteConfigOrigin =
    domain.join(".") === "i.posthog.com" ? `https://${region}-assets.i.posthog.com` : undefined;
  return {
    analytics: { apiKey, host, ...(Object.keys(options).length ? { options } : {}) },
    origins: [host, ...(remoteConfigOrigin ? [remoteConfigOrigin] : [])],
  };
}
