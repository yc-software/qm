import { createHmac } from "node:crypto";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";

export function viewerIdentityKey(secret: string, deploymentId: string): string {
  return createHmac("sha256", secret).update(`viewer:${deploymentId}`).digest("base64url");
}

export interface DeployGitAccess {
  deploymentId: string;
  permission: "read" | "write";
  principalId?: string;
  version: 1;
  exp: number;
}

export function mintDeployGitAccess(secret: string, access: Omit<DeployGitAccess, "version">): Promise<string> {
  return mintSignedPayload({ ...access, version: 1 }, secret);
}

export async function verifyDeployGitAccess(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<DeployGitAccess | null> {
  const access = (await verifySignedPayload(token, secret)) as DeployGitAccess | null;
  if (
    !access ||
    access.version !== 1 ||
    typeof access.deploymentId !== "string" ||
    (access.permission !== "read" && access.permission !== "write")
  )
    return null;
  if (access.principalId !== undefined && typeof access.principalId !== "string") return null;
  if (typeof access.exp !== "number" || now >= access.exp) return null;
  return access;
}
