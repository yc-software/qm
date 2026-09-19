import { createHmac } from "node:crypto";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { orgId } from "../config.ts";
import { currentTenant } from "../tenancy/context.ts";

export function viewerIdentityKey(secret: string, deploymentId: string): string {
  return createHmac("sha256", secret).update(`viewer:${deploymentId}`).digest("base64url");
}

export interface DeployGitAccess {
  orgId?: string;
  deploymentId: string;
  permission: "read" | "write";
  principalId?: string;
  version: 1;
  exp: number;
}

export function mintDeployGitAccess(secret: string, access: Omit<DeployGitAccess, "version">): Promise<string> {
  return mintSignedPayload({ ...access, orgId: orgId(), version: 1 }, secret);
}

export async function verifyDeployGitAccess(
  secret: string,
  token: string,
  now = Date.now(),
  expectedTenantId: string | undefined = currentTenant()?.id,
  requireTenantBinding: boolean = currentTenant()?.pooled ?? false,
): Promise<DeployGitAccess | null> {
  const access = (await verifySignedPayload(token, secret)) as DeployGitAccess | null;
  if (
    !access ||
    access.version !== 1 ||
    typeof access.deploymentId !== "string" ||
    (access.permission !== "read" && access.permission !== "write")
  )
    return null;
  if (access.orgId !== undefined && (typeof access.orgId !== "string" || !access.orgId)) return null;
  if (requireTenantBinding && (!expectedTenantId || access.orgId !== expectedTenantId)) return null;
  if (expectedTenantId && access.orgId !== undefined && access.orgId !== expectedTenantId) return null;
  if (access.principalId !== undefined && typeof access.principalId !== "string") return null;
  if (typeof access.exp !== "number" || now >= access.exp) return null;
  return access;
}

export function deploymentGitToken(authorization: string | undefined, url: URL): string | null {
  const authz = /^(basic|bearer)\s+(\S.*)$/i.exec(authorization ?? "");
  if (authz) {
    const token = authz[2]!;
    if (authz[1]!.toLowerCase() === "bearer") return token;
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const user = colon < 0 ? decoded : decoded.slice(0, colon);
      const pass = colon < 0 ? "" : decoded.slice(colon + 1);
      return pass || user || null;
    } catch {
      return null;
    }
  }
  return url.searchParams.get("token") ?? url.searchParams.get("access_token");
}
