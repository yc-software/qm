import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";

const PLUGIN_SETTINGS_PATH = "/v1/plugin-settings";

export type PluginSettings = Readonly<Record<string, string>>;

export function corePluginSettings(
  coreApiUrl: string,
  signingSecret: string | undefined,
  ttlMs = 30_000,
  now: () => number = Date.now,
): () => Promise<PluginSettings> {
  let cached: { at: number; settings: Promise<PluginSettings> } | undefined;
  const load = async (): Promise<PluginSettings> => {
    const path = withSourceAuthNonce(PLUGIN_SETTINGS_PATH, signingSecret);
    const response = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`core refused the plugin settings read: HTTP ${response.status}`);
    const { values } = (await response.json()) as { values?: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(values ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  };
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.settings;
    const entry = { at: now(), settings: load() };
    cached = entry;
    entry.settings.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return entry.settings;
  };
}
