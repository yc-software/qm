import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { isTenantId } from "../../chassis/src/tenant.ts";
import { open } from "./session.ts";

export interface SignInTenant {
  id: string;
  brandName?: string;
}

export interface VerifiedSignIn {
  sub: string;
  name: string;
  claims: Record<string, unknown>;
  userinfo: Record<string, unknown>;
}

export interface TrustedSignIn {
  sub: string;
  name: string;
}

export interface EmailTenants {
  tenants: SignInTenant[];
  shared: boolean;
}

export interface Workspace {
  tenant: string;
  trustedClient?: { clientId: string; clientSecret: string };
}

export interface ChoiceClaims {
  k: "choice";
  signIn?: VerifiedSignIn;
  trusted?: TrustedSignIn;
  returnTo: string;
  tenants: string[];
  exp: number;
}

export function verifiedEmail(userinfo: Record<string, unknown>): string | null {
  const email = userinfo.email;
  const verified = userinfo.email_verified;
  if (typeof email !== "string" || !email.includes("@") || (verified !== true && verified !== "true")) return null;
  return email.trim().toLowerCase();
}

export function coreEmailTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
): Promise<EmailTenants> {
  return coreTenants(coreApiUrl, signingSecret, `email-tenants?email=${encodeURIComponent(email)}`);
}

export function corePrincipalTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  principal: string,
): Promise<EmailTenants> {
  return coreTenants(coreApiUrl, signingSecret, `principal-tenants?principal=${encodeURIComponent(principal)}`);
}

export async function coreSignInTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  who: { email?: string | null; principal: string },
): Promise<EmailTenants> {
  const [byEmail, byPrincipal] = await Promise.all([
    who.email ? coreEmailTenants(coreApiUrl, signingSecret, who.email) : undefined,
    corePrincipalTenants(coreApiUrl, signingSecret, who.principal),
  ]);
  const tenants = new Map<string, SignInTenant>();
  for (const tenant of [...(byEmail?.tenants ?? []), ...byPrincipal.tenants])
    if (!tenants.has(tenant.id)) tenants.set(tenant.id, tenant);
  return { tenants: [...tenants.values()], shared: byPrincipal.shared || byEmail?.shared === true };
}

async function coreTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  query: string,
): Promise<EmailTenants> {
  const path = withSourceAuthNonce(`/v1/auth/broker/${query}`, signingSecret);
  const r = await fetch(`${coreApiUrl}${path}`, {
    headers: signedHeaders(signingSecret, "GET", path),
    signal: AbortSignal.timeout(4_000),
  });
  if (!r.ok) throw new Error(`workspace lookup failed: HTTP ${r.status}`);
  const body = (await r.json()) as { tenants?: unknown; shared?: unknown };
  const tenants = Array.isArray(body.tenants) ? body.tenants : [];
  const valid = tenants.flatMap((t: { id?: unknown; brandName?: unknown }) =>
    isTenantId(t?.id) ? [{ id: t.id, ...(typeof t.brandName === "string" ? { brandName: t.brandName } : {}) }] : [],
  );
  return { tenants: valid, shared: body.shared === true };
}

export function coreWorkspace(coreApiUrl: string, signingSecret: string | undefined) {
  const cache = new LRUCache<string, { found: Workspace | null }>({ max: 1_000, ttl: 60_000 });
  return async (handle: string): Promise<Workspace | null> => {
    if (!/^[a-z0-9]{2,30}$/.test(handle)) return null;
    const hit = cache.get(handle);
    if (hit) return hit.found;
    const path = withSourceAuthNonce(`/v1/auth/broker/workspace?handle=${encodeURIComponent(handle)}`, signingSecret);
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) throw new Error(`workspace lookup failed: HTTP ${r.status}`);
    const { tenant, trustedClient: c } = (await r.json()) as {
      tenant?: unknown;
      trustedClient?: { clientId?: unknown; clientSecret?: unknown };
    };
    const trustedClient =
      typeof c?.clientId === "string" && typeof c.clientSecret === "string" && c.clientSecret.length >= 32
        ? { clientId: c.clientId, clientSecret: c.clientSecret }
        : undefined;
    const found = isTenantId(tenant) ? { tenant, ...(trustedClient ? { trustedClient } : {}) } : null;
    cache.set(handle, { found });
    return found;
  };
}

export function openChoice(token: string | null, key: Buffer, now: number): ChoiceClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "choice" || typeof p.exp !== "number" || now >= p.exp * 1000) return null;
  if (!Array.isArray(p.tenants) || !p.tenants.every(isTenantId) || typeof p.returnTo !== "string") return null;
  return p as unknown as ChoiceClaims;
}

export function tenantChoiceForms(tenants: readonly SignInTenant[], escape: (s: string) => string): string {
  return tenants
    .map(
      ({ id, brandName }) =>
        `<form method="post" action="/auth/tenant"><input type="hidden" name="tenant" value="${escape(id)}">` +
        `<button class="btn primary" type="submit">${escape(brandName?.trim() || id.slice(0, 8))}</button></form>`,
    )
    .join("");
}
