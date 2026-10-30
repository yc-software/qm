import { portalIdentityClaims, type PortalIdentity } from "../../plugins/chassis/src/portal-identity.ts";
import { mintSignedPayload, verifySignedPayload } from "./signed-token.ts";

export function mintPortalIdentity(claims: PortalIdentity, secret: string): Promise<string> {
  return mintSignedPayload(claims, secret);
}

export async function verifyPortalIdentity(
  token: string,
  secret: string,
  nowMs: number,
): Promise<PortalIdentity | null> {
  return portalIdentityClaims(await verifySignedPayload(token, secret), nowMs);
}
