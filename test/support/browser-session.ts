import { deriveKey, seal } from "../../plugins/portal/src/session.ts";

const SECRET = "test-browser-session-secret-0123456789abcdef";

export const browserSessionDeps = {
  portalSession: { secret: SECRET, maxAgeSeconds: 3600 },
  portalUrl: "https://qm.test",
};

export function browserSessionCookie(sub: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub, org: "default-org", iat, exp: iat + 3600 };
  return `portal_session=${encodeURIComponent(seal(claims, deriveKey(SECRET, "portal.session.v1")))}`;
}
