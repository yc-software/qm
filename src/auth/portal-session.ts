import { deriveKey, openSessionCookie, type SessionClaims } from "../../plugins/portal/src/session.ts";
import { orgId } from "../config.ts";

export function portalSession(
  cookies: string | undefined,
  name: "portal_session" | "portal_session_x",
  secret: string,
  maxAgeSeconds?: number,
): SessionClaims | null {
  return openSessionCookie(cookies, name, deriveKey(secret, "portal.session.v1"), Date.now(), orgId(), maxAgeSeconds);
}
