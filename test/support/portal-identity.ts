import { createHmac } from "node:crypto";
import { PORTAL_IDENTITY_HEADER, type PortalIdentity } from "../../src/auth/portal-identity.ts";

export { PORTAL_IDENTITY_HEADER };

export function mintPortalIdentity(claims: PortalIdentity, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
