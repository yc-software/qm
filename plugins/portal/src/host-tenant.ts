import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { isTenantId } from "../../chassis/src/tenant.ts";
import { open, seal } from "./session.ts";

export interface MappedHost {
  host: string;
  origin: string;
  tenant: string;
}

export interface HandoffClaims {
  k: "handoff";
  sub: string;
  name?: string;
  t: string;
  host: string;
  returnTo: string;
  jti: string;
  exp: number;
}

const HANDOFF_TTL_S = 60;
const CACHE_MS = 60_000;
const onHost = new AsyncLocalStorage<MappedHost | undefined>();

export function mappedHost(): MappedHost | undefined {
  return onHost.getStore();
}

export function runOnHost<T>(host: MappedHost | undefined, fn: () => T): T {
  return onHost.run(host, fn);
}

export function hostName(value: string | undefined): string {
  return (value ?? "").toLowerCase().split(":")[0]!;
}

export function coreHostTenant(coreApiUrl: string, signingSecret: string | undefined) {
  return async (host: string): Promise<string | null> => {
    const path = withSourceAuthNonce(`/v1/auth/broker/host-tenant?host=${encodeURIComponent(host)}`, signingSecret);
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) throw new Error(`host lookup failed: HTTP ${r.status}`);
    const { tenant } = (await r.json()) as { tenant?: unknown };
    return isTenantId(tenant) ? tenant : null;
  };
}

export function createHostTenants(lookup: (host: string) => Promise<string | null>) {
  const cache = new Map<string, { tenant: string | null; until: number }>();
  return async (host: string): Promise<string | null> => {
    const hit = cache.get(host);
    if (hit && hit.until > Date.now()) return hit.tenant;
    const tenant = await lookup(host);
    if (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
    cache.set(host, { tenant, until: Date.now() + CACHE_MS });
    return tenant;
  };
}

export function hostReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f]/.test(value) ? value : "/";
}

export function sessionOnHost<T extends { t?: string }>(
  cookieHeader: string | undefined,
  tenant: string,
  openSession: (value: string) => T | null,
): T | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== "portal_session") continue;
    let value: string;
    try {
      value = decodeURIComponent(rest.join("="));
    } catch {
      continue;
    }
    const session = openSession(value);
    if (session?.t === tenant) return session;
  }
  return null;
}

export function mintHandoff(
  who: { sub: string; name?: string },
  target: MappedHost,
  returnTo: string,
  key: Buffer,
): string {
  const claims: HandoffClaims = {
    k: "handoff",
    sub: who.sub,
    ...(who.name ? { name: who.name } : {}),
    t: target.tenant,
    host: target.host,
    returnTo: hostReturnTo(returnTo),
    jti: randomBytes(16).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + HANDOFF_TTL_S,
  };
  return seal(claims, key);
}

export function openHandoff(token: string | null, key: Buffer, target: MappedHost): HandoffClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "handoff" || typeof p.exp !== "number" || Date.now() >= p.exp * 1000) return null;
  if (typeof p.sub !== "string" || !p.sub || typeof p.jti !== "string" || typeof p.returnTo !== "string") return null;
  if (p.t !== target.tenant || p.host !== target.host) return null;
  return p as unknown as HandoffClaims;
}
