import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { isTenantId } from "../../chassis/src/tenant.ts";
import { clearCookie, open, readCookie, seal, withoutCookies, type SessionClaims } from "./session.ts";

export interface TrustedClient {
  clientId: string;
  clientSecret: string;
}

export interface HostRecord {
  tenant: string;
  trustedClient?: TrustedClient;
  app?: true;
}

export interface MappedHost extends HostRecord {
  host: string;
  origin: string;
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
  return async (host: string): Promise<HostRecord | null> => {
    const path = withSourceAuthNonce(`/v1/auth/broker/host-tenant?host=${encodeURIComponent(host)}`, signingSecret);
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) throw new Error(`host lookup failed: HTTP ${r.status}`);
    const {
      tenant,
      trustedClient: c,
      app,
    } = (await r.json()) as {
      tenant?: unknown;
      trustedClient?: Partial<TrustedClient>;
      app?: unknown;
    };
    if (!isTenantId(tenant)) return null;
    if (app === true) return { tenant, app: true };
    const usable = typeof c?.clientId === "string" && typeof c.clientSecret === "string" && c.clientSecret.length >= 32;
    return { tenant, ...(usable ? { trustedClient: { clientId: c.clientId!, clientSecret: c.clientSecret! } } : {}) };
  };
}

export function createHostTenants(lookup: (host: string) => Promise<HostRecord | null>) {
  const cache = new LRUCache<string, { record: HostRecord | null }>({ max: 1_000, ttl: CACHE_MS });
  return async (host: string): Promise<HostRecord | null> => {
    const hit = cache.get(host);
    if (hit) return hit.record;
    const record = await lookup(host);
    cache.set(host, { record });
    return record;
  };
}

export function hostReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f]/.test(value) ? value : "/";
}

export function sessionOnHost<T extends { t?: string; h?: string }>(
  cookieHeader: string | undefined,
  { tenant, host }: { tenant: string; host: string },
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
    if (session?.t === tenant && session.h === host) return session;
  }
  return null;
}

const SESSION_COOKIES = new Set(["portal_session", "portal_impersonate"]);

export function createHostSessions(config: {
  cookieDomain: string | undefined;
  secure: boolean;
  openSession: (value: string | null) => SessionClaims | null;
}) {
  const cookieDomain = (): string | undefined => (mappedHost() ? undefined : config.cookieDomain);
  const signedOutCookies = (): string[] => {
    const domain = cookieDomain();
    const clear = (name: string, path: string, scope?: string) => clearCookie(name, path, config.secure, scope);
    return [
      clear("portal_impersonate", "/"),
      clear("portal_trusted_tmp", "/auth/trusted"),
      clear("portal_session", "/", domain),
      clear("portal_session_x", "/", domain),
      ...(domain ? [clear("portal_session", "/"), clear("portal_session_x", "/")] : []),
    ];
  };
  const shared = (cookieHeader: string | undefined): SessionClaims | null => {
    const session = config.openSession(readCookie(cookieHeader, "portal_session"));
    return session?.h === undefined ? session : null;
  };
  return {
    cookieDomain,
    signedOutCookies,
    shared,
    current(cookieHeader: string | undefined): SessionClaims | null {
      const mapped = mappedHost();
      return mapped ? sessionOnHost(cookieHeader, mapped, config.openSession) : shared(cookieHeader);
    },
    signOutRequest(req: IncomingMessage, res: ServerResponse): void {
      for (const cookie of signedOutCookies()) res.appendHeader("set-cookie", cookie);
      req.headers.cookie = withoutCookies(req.headers.cookie, SESSION_COOKIES);
    },
  };
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
