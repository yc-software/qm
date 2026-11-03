import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";

const PLUGIN_SETTINGS_PATH = "/v1/plugin-settings";

export type PluginSettings = Readonly<Record<string, string>>;

export function corePluginSettings(
  coreApiUrl: string,
  signingSecret: string | undefined,
  ttlMs = 30_000,
  now: () => number = Date.now,
  failureTtlMs = 2_000,
): () => Promise<PluginSettings> {
  type Entry = { until: number; unreachable: boolean; settings: Promise<PluginSettings> };
  let cached: Entry | undefined;
  const load = async (entry: Entry): Promise<PluginSettings> => {
    const path = withSourceAuthNonce(PLUGIN_SETTINGS_PATH, signingSecret);
    const response = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    }).catch((error: unknown) => {
      entry.unreachable = true;
      throw error;
    });
    if (!response.ok) throw new Error(`core refused the plugin settings read: HTTP ${response.status}`);
    const { values } = (await response.json()) as { values?: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(values ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  };
  return () => {
    if (cached && now() < cached.until) return cached.settings;
    const entry: Entry = { until: now() + ttlMs, unreachable: false, settings: Promise.resolve({}) };
    entry.settings = load(entry);
    cached = entry;
    entry.settings.catch(() => {
      if (cached !== entry) return;
      if (entry.unreachable) entry.until = now() + failureTtlMs;
      else cached = undefined;
    });
    return entry.settings;
  };
}
