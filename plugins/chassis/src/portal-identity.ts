import { createHmac, timingSafeEqual } from "node:crypto";
import { edgeTenant } from "./tenant-hosts.ts";

export interface PortalIdentity {
  p: string;
  authenticatedAs?: string;
  n?: string;
  imp?: string;
  t?: string;
  exp: number;
}

const coreTenant = (): string | undefined => edgeTenant()?.orgId ?? (process.env.CORE_ORG_ID?.trim() || undefined);

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256" }), "utf8").toString("base64url");

function digest(signingInput: string, secret: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

export function mintPortalIdentity(claims: PortalIdentity, secret: string): string {
  const tenant = coreTenant();
  const stamped = tenant ? { ...claims, t: tenant } : claims;
  const signingInput = `${HEADER}.${Buffer.from(JSON.stringify(stamped), "utf8").toString("base64url")}`;
  return `${signingInput}.${digest(signingInput, secret)}`;
}

export function verifyPortalIdentity(token: string, secret: string, nowMs: number): PortalIdentity | null {
  const [header, payload, got, ...rest] = token.split(".");
  if (!header || !payload || got === undefined || rest.length) return null;
  const expected = digest(`${header}.${payload}`, secret);
  if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;
  let claims: PortalIdentity;
  try {
    if (JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg !== "HS256") return null;
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PortalIdentity;
  } catch {
    return null;
  }
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (claims.authenticatedAs !== undefined && (typeof claims.authenticatedAs !== "string" || !claims.authenticatedAs))
    return null;
  if (nowMs > claims.exp) return null;
  return claims;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";
