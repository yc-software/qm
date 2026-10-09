import { validEmail } from "../identity/external-members.ts";
import { parseScopeId, scopeId, type Permission, type ScopeId } from "../types.ts";

/** An email recipient is an email identity: the grant lands on its principal, created on first share. */
export async function deploymentShareScope(
  grantee: ScopeId,
  permission: Permission | null,
  principals: { act(handle: string, opts?: { email?: string | null }): Promise<string> },
  canManageEmail?: (email: string) => Promise<boolean>,
): Promise<ScopeId> {
  const { kind, ref } = parseScopeId(grantee);
  if (kind !== "personal" || !ref?.includes("@")) return grantee;
  const email = ref.trim().toLowerCase();
  if (!validEmail(email)) throw new Error("a valid email address is required");
  if (permission === "write" && !(await canManageEmail?.(email)))
    throw new Error("email recipients outside the directory can only view apps");
  return scopeId("personal", await principals.act(email, { email }));
}

export interface DeploymentInvitation {
  emailSent: boolean;
  emailProblem?: string;
  appUrl?: string;
  alreadyShared?: true;
}
