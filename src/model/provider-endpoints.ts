/**
 * Provider endpoint overrides.
 *
 * One place decides which base URL each model provider is reached at.
 * Config parses and validates the `*_BASE_URL` environment variables,
 * wiring injects them here, and everything that issues a request — the
 * in-process pi harness, the child-process harness environments, and
 * admin API-key validation — resolves through this module. No harness
 * reads its own override.
 */

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "xai"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_BASE_URL_ENV: Record<ProviderId, string | null> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
  xai: null,
};

export type ProviderBaseUrls = Partial<Record<ProviderId, string>>;

/**
 * Validate and normalize a provider base URL. Returns the normalized
 * origin+path with trailing slashes removed. Throws on anything that
 * would silently misroute requests: non-HTTP(S) schemes, embedded
 * credentials, query strings, and fragments.
 */
export function parseProviderBaseUrl(envName: string, value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${envName} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${envName} must be an http(s) URL, got ${url.protocol}//`);
  if (url.username || url.password) throw new Error(`${envName} must not contain credentials`);
  if (url.search) throw new Error(`${envName} must not contain a query string`);
  if (url.hash) throw new Error(`${envName} must not contain a fragment`);
  return trimmed;
}

export function providerBaseUrlsFromEnv(env: NodeJS.ProcessEnv): ProviderBaseUrls {
  const urls: ProviderBaseUrls = {};
  for (const provider of PROVIDER_IDS) {
    const envName = PROVIDER_BASE_URL_ENV[provider];
    if (!envName) continue;
    const raw = env[envName];
    if (raw?.trim()) urls[provider] = parseProviderBaseUrl(envName, raw);
  }
  return urls;
}

let configured: ProviderBaseUrls = {};

/** Called once by wiring with the config-parsed overrides. */
export function setProviderBaseUrls(urls: ProviderBaseUrls): void {
  configured = { ...urls };
}

/** The override for a provider, if one is configured. */
export function providerBaseUrl(provider: string): string | undefined {
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) return undefined;
  const id = provider as ProviderId;
  return PROVIDER_BASE_URL_ENV[id] ? configured[id] : undefined;
}
