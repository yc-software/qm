import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";

export interface DeployOwnerSession {
  kind: "dpl-owner";
  slug: string;
  sub: string;
  version: 1;
  exp: number;
}

export function mintDeployOwnerToken(
  secret: string,
  session: Omit<DeployOwnerSession, "kind" | "version">,
): Promise<string> {
  return mintSignedPayload({ ...session, kind: "dpl-owner", version: 1 } satisfies DeployOwnerSession, secret);
}

export async function verifyDeployOwnerToken(
  secret: string,
  token: string,
  slug: string,
  now = Date.now(),
): Promise<DeployOwnerSession | null> {
  const session = (await verifySignedPayload(token, secret)) as DeployOwnerSession | null;
  if (!session || session.kind !== "dpl-owner" || session.version !== 1) return null;
  if (typeof session.slug !== "string" || session.slug !== slug) return null;
  if (typeof session.sub !== "string" || !session.sub) return null;
  if (typeof session.exp !== "number" || now >= session.exp) return null;
  return session;
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
