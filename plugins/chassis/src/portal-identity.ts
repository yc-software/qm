import { createHmac, timingSafeEqual } from "node:crypto";

export interface PortalIdentity {
  orgId?: string;
  p: string;
  n?: string;
  imp?: string;
  exp: number;
}

function digest(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintPortalIdentity(claims: PortalIdentity, secret: string): string {
  const orgId = process.env.CORE_TENANT_ID ?? process.env.CORE_ORG_ID ?? claims.orgId;
  const payload = Buffer.from(JSON.stringify({ ...claims, ...(orgId ? { orgId } : {}) }), "utf8").toString("base64url");
  return `${payload}.${digest(payload, secret)}`;
}

export function verifyPortalIdentity(
  token: string,
  secret: string,
  nowMs: number,
  expectedTenantId: string | undefined = process.env.CORE_TENANT_ID,
  requireTenantBinding: boolean = expectedTenantId !== undefined,
): PortalIdentity | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expected = digest(payload, secret);
  const got = token.slice(dot + 1);
  if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;
  let claims: PortalIdentity;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PortalIdentity;
  } catch {
    return null;
  }
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (claims.orgId !== undefined && (typeof claims.orgId !== "string" || !claims.orgId)) return null;
  if (requireTenantBinding && (!expectedTenantId || claims.orgId !== expectedTenantId)) return null;
  if (expectedTenantId && claims.orgId !== undefined && claims.orgId !== expectedTenantId) return null;
  if (nowMs > claims.exp) return null;
  return claims;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";
