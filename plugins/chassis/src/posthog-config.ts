export function posthogConfig(
  raw: string | undefined,
): { apiKey: string; host: string; sessionRecording?: Record<string, unknown> } | undefined {
  if (!raw?.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("POSTHOG_CONFIG must be a JSON object");
  const { token, api_host: apiHost, session_recording: sessionRecording, ...rest } = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length) throw new Error(`POSTHOG_CONFIG has unsupported keys: ${unknownKeys.join(", ")}`);
  if (typeof token !== "string" || !/^phc_[A-Za-z0-9]+$/.test(token))
    throw new Error("POSTHOG_CONFIG token must be a public project ingestion token");
  if (apiHost !== undefined && typeof apiHost !== "string") throw new Error("POSTHOG_CONFIG api_host must be a string");
  if (
    sessionRecording !== undefined &&
    (!sessionRecording || typeof sessionRecording !== "object" || Array.isArray(sessionRecording))
  )
    throw new Error("POSTHOG_CONFIG session_recording must be an object");
  const host = new URL(apiHost || "https://us.i.posthog.com");
  if (
    host.protocol !== "https:" ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== "/"
  ) {
    throw new Error("POSTHOG_CONFIG api_host must be an HTTPS origin");
  }
  return {
    apiKey: token,
    host: host.origin,
    ...(sessionRecording ? { sessionRecording: sessionRecording as Record<string, unknown> } : {}),
  };
}
