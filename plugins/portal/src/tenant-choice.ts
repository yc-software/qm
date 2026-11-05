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

export interface ChoiceClaims {
  k: "choice";
  signIn: VerifiedSignIn;
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

export async function coreEmailTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
): Promise<SignInTenant[]> {
  const path = withSourceAuthNonce(`/v1/auth/broker/email-tenants?email=${encodeURIComponent(email)}`, signingSecret);
  const r = await fetch(`${coreApiUrl}${path}`, {
    headers: signedHeaders(signingSecret, "GET", path),
    signal: AbortSignal.timeout(4_000),
  });
  if (!r.ok) throw new Error(`workspace lookup failed: HTTP ${r.status}`);
  const tenants = ((await r.json()) as { tenants?: unknown }).tenants;
  if (!Array.isArray(tenants)) return [];
  return tenants.flatMap((t: { id?: unknown; brandName?: unknown }) =>
    isTenantId(t?.id) ? [{ id: t.id, ...(typeof t.brandName === "string" ? { brandName: t.brandName } : {}) }] : [],
  );
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
