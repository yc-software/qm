import { isComputerCapability } from "../auth/capability-token.ts";
import { parseScopeId } from "../types.ts";
import type { PrivateContext } from "../sessions/private-context.ts";
import { createHmac } from "node:crypto";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";

export function viewerIdentityKey(secret: string, appId: string): string {
  return createHmac("sha256", secret).update(`viewer:${appId}`).digest("base64url");
}

export type DeployGitContext = Omit<PrivateContext, "actorId" | "sourceProvenance">;

export interface DeployGitAccess {
  context?: DeployGitContext;
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
  if (access.context !== undefined) {
    const context = access.context;
    if (!context || typeof context !== "object" || Array.isArray(context) || !access.principalId) return null;
    for (const field of ["scopeId", "audienceScopeId"] as const)
      if (
        context[field] !== undefined &&
        (typeof context[field] !== "string" || parseScopeId(context[field]).kind === null)
      )
        return null;
    if (
      context.sessionId !== undefined &&
      (typeof context.sessionId !== "string" || !context.sessionId || !context.scopeId)
    )
      return null;
    if (context.privateRead !== undefined && typeof context.privateRead !== "boolean") return null;
    if (context.computer !== undefined && !isComputerCapability(context.computer)) return null;
    if (context.personalOnly !== undefined && context.personalOnly !== true) return null;
    if (context.botActor !== undefined && typeof context.botActor !== "boolean") return null;
  }
  return access;
}
