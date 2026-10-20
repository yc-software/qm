import { buildDiscoveryUrls } from "@modelcontextprotocol/sdk/client/auth.js";
import { errMessage } from "../util/errors.ts";

export function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseScopes(v: unknown): string[] | undefined {
  const raw: unknown[] | undefined = typeof v === "string" ? v.split(/\s+/) : undefined;
  return (raw ?? (Array.isArray(v) ? (v as unknown[]) : undefined))
    ?.filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => x.trim());
}

export interface DiscoveredOAuth {
  authorize?: string;
  token?: string;
  scopes?: string[];
  errors: string[];
}

async function fetchMeta(url: string, errors: string[]): Promise<Record<string, unknown> | undefined> {
  let r: Response;
  try {
    r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    errors.push(`${url}: ${errMessage(e)}`);
    return undefined;
  }
  if (!r.ok) {
    errors.push(`${url}: HTTP ${r.status}`);
    return undefined;
  }
  const meta: unknown = await r.json().catch(() => undefined);
  if (meta && typeof meta === "object") return meta as Record<string, unknown>;
  errors.push(`${url}: response is not a JSON object`);
  return undefined;
}

function wellKnown(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  return [...new Set([`${base.origin}/.well-known/${suffix}${path}`, `${base.origin}/.well-known/${suffix}`])];
}

export async function discoverOAuth(resource: URL): Promise<DiscoveredOAuth> {
  const errors: string[] = [];
  for (const url of wellKnown(resource, "oauth-protected-resource")) {
    const meta = await fetchMeta(url, errors);
    const issuer = Array.isArray(meta?.authorization_servers) ? httpsUrl(meta.authorization_servers[0]) : undefined;
    if (!issuer) {
      if (meta) errors.push(`${url}: no HTTPS authorization_servers entry`);
      continue;
    }
    const scopes = parseScopes(meta?.scopes_supported);
    for (const { url } of buildDiscoveryUrls(issuer)) {
      const candidate = url.href;
      const server = await fetchMeta(candidate, errors);
      if (!server) continue;
      const authorize = httpsUrl(server.authorization_endpoint);
      const token = httpsUrl(server.token_endpoint);
      if (!authorize || !token) errors.push(`${candidate}: missing or non-HTTPS authorization/token endpoint`);
      return { authorize, token, scopes, errors };
    }
    return { scopes, errors };
  }
  return { errors };
}
