export function posthogConfig(
  raw: string | undefined,
): { apiKey: string; host: string; options: Record<string, unknown> } | undefined {
  if (!raw?.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("POSTHOG_CONFIG must be a JSON object");
  const { token, api_host: apiHost, ...options } = parsed as Record<string, unknown>;
  if (typeof token !== "string" || !/^phc_[A-Za-z0-9]+$/.test(token))
    throw new Error("POSTHOG_CONFIG token must be a public project ingestion token");
  if (apiHost !== undefined && typeof apiHost !== "string") throw new Error("POSTHOG_CONFIG api_host must be a string");
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
  return { apiKey: token, host: host.origin, options };
}
