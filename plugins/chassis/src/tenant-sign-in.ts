import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { boundTenant } from "./tenant.ts";

const SIGN_IN_PATH = "/v1/auth/broker/sign-in-settings";

export interface TenantOidcClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface TenantSignIn {
  allowedEmails?: string[];
  oidcClient?: TenantOidcClient;
  clientSecret?: string;
}

export type TenantSignInLookup = () => Promise<TenantSignIn>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function oidcClientOf(value: unknown): TenantOidcClient | undefined {
  if (!value || typeof value !== "object") return undefined;
  const issuer = text(Reflect.get(value, "issuer"));
  const clientId = text(Reflect.get(value, "clientId"));
  const clientSecret = text(Reflect.get(value, "clientSecret"));
  return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : undefined;
}

export function parseTenantSignIn(body: unknown): TenantSignIn {
  if (!body || typeof body !== "object") return {};
  const emails: unknown = Reflect.get(body, "allowedEmails");
  const allowedEmails = Array.isArray(emails)
    ? emails.filter((email): email is string => typeof email === "string").map((email) => email.toLowerCase())
    : undefined;
  const oidcClient = oidcClientOf(Reflect.get(body, "oidcClient"));
  const clientSecret = text(Reflect.get(body, "clientSecret"));
  return {
    ...(allowedEmails ? { allowedEmails } : {}),
    ...(oidcClient ? { oidcClient } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

export function coreTenantSignIn(core: string, secret: string | undefined): TenantSignInLookup {
  const cache = new LRUCache<string, TenantSignIn>({ max: 1000, ttl: 30_000 });
  return async () => {
    const tenant = boundTenant();
    if (!tenant) return {};
    const cached = cache.get(tenant);
    if (cached) return cached;
    const path = withSourceAuthNonce(SIGN_IN_PATH, secret);
    const r = await fetch(`${core}${path}`, {
      headers: signedHeaders(secret, "GET", path),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.status === 404) return {};
    if (!r.ok) throw new Error(`core refused the tenant sign-in settings: HTTP ${r.status}`);
    const found = parseTenantSignIn(await r.json());
    cache.set(tenant, found);
    return found;
  };
}
