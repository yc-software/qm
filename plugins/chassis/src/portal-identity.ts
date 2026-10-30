import { open, seal } from "./signed-token.ts";

export interface PortalIdentity {
  p: string;
  authenticatedAs?: string;
  n?: string;
  imp?: string;
  exp: number;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";

export function portalIdentityClaims(value: unknown, nowMs: number): PortalIdentity | null {
  const claims = value as PortalIdentity | null;
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (claims.authenticatedAs !== undefined && (typeof claims.authenticatedAs !== "string" || !claims.authenticatedAs))
    return null;
  if (nowMs > claims.exp) return null;
  return claims;
}

export function mintPortalIdentity(claims: PortalIdentity, secret: string): string {
  return seal(claims, Buffer.from(secret));
}

export function verifyPortalIdentity(token: string, secret: string, nowMs: number): PortalIdentity | null {
  return portalIdentityClaims(open(token, Buffer.from(secret)), nowMs);
}
