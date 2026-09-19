import { mintSignedPayload, verifySignedPayload } from "./signed-token.ts";
import { orgId } from "../config.ts";
import { currentTenant } from "../tenancy/context.ts";

export interface PortalIdentity {
  orgId?: string;
  p: string;
  n?: string;
  imp?: string;
  exp: number;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";

export function mintPortalIdentity(claims: PortalIdentity, secret: string): Promise<string> {
  return mintSignedPayload({ ...claims, orgId: orgId() }, secret);
}

export async function verifyPortalIdentity(
  token: string,
  secret: string,
  nowMs: number,
  expectedTenantId: string | undefined = currentTenant()?.id,
  requireTenantBinding: boolean = currentTenant()?.pooled ?? false,
): Promise<PortalIdentity | null> {
  const claims = (await verifySignedPayload(token, secret)) as PortalIdentity | null;
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (claims.orgId !== undefined && (typeof claims.orgId !== "string" || !claims.orgId)) return null;
  if (requireTenantBinding && (!expectedTenantId || claims.orgId !== expectedTenantId)) return null;
  if (expectedTenantId && claims.orgId !== undefined && claims.orgId !== expectedTenantId) return null;
  if (nowMs > claims.exp) return null;
  return claims;
}
