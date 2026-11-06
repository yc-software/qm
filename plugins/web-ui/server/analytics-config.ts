export function productAnalyticsConfig(env: NodeJS.ProcessEnv): {
  analytics?: { apiKey: string; host: string; sessionRecording?: Record<string, unknown> };
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
  const sessionRecording: unknown = env.POSTHOG_SESSION_RECORDING
    ? JSON.parse(env.POSTHOG_SESSION_RECORDING)
    : undefined;
  if (
    sessionRecording !== undefined &&
    (!sessionRecording || typeof sessionRecording !== "object" || Array.isArray(sessionRecording))
  )
    throw new Error("POSTHOG_SESSION_RECORDING must be a JSON object");
  const [region, ...domain] = host.hostname.split(".");
  const remoteConfigOrigin =
    sessionRecording && domain.join(".") === "i.posthog.com" ? `https://${region}-assets.i.posthog.com` : undefined;
  return {
    analytics: {
      apiKey,
      host: host.origin,
      ...(sessionRecording ? { sessionRecording: sessionRecording as Record<string, unknown> } : {}),
    },
    origins: [host.origin, ...(remoteConfigOrigin ? [remoteConfigOrigin] : [])],
  };
}
