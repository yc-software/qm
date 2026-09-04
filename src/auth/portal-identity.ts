import { verifySignedPayload } from "./signed-token.ts";

export interface PortalIdentity {
  p: string;
  n?: string;
  imp?: string;
  exp: number;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";

export async function verifyPortalIdentity(
  token: string,
  secret: string,
  nowMs: number,
): Promise<PortalIdentity | null> {
  const claims = (await verifySignedPayload(token, secret)) as PortalIdentity | null;
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (nowMs > claims.exp) return null;
  return claims;
}
