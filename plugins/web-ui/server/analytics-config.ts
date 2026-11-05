export function productAnalyticsConfig(env: NodeJS.ProcessEnv): {
  analytics?: { apiKey: string; host: string; config?: Record<string, unknown> };
  origins: string[];
} {
  const apiKey = env.POSTHOG_API_KEY?.trim();
  if (!apiKey) return { origins: [] };
  if (!/^phc_[A-Za-z0-9]+$/.test(apiKey)) throw new Error("POSTHOG_API_KEY must be a public project ingestion token");
  const host = new URL(env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com");
  if (
    host.protocol !== "https:" ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== "/"
  ) {
    throw new Error("POSTHOG_HOST must be an HTTPS origin");
  }
  const config: unknown = env.POSTHOG_CONFIG ? JSON.parse(env.POSTHOG_CONFIG) : undefined;
  if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config)))
    throw new Error("POSTHOG_CONFIG must be a JSON object");
  const [region, ...domain] = host.hostname.split(".");
  const remoteConfigOrigin =
    config && domain.join(".") === "i.posthog.com" ? `https://${region}-assets.i.posthog.com` : undefined;
  return {
    analytics: { apiKey, host: host.origin, ...(config ? { config: config as Record<string, unknown> } : {}) },
    origins: [host.origin, ...(remoteConfigOrigin ? [remoteConfigOrigin] : [])],
  };
}
