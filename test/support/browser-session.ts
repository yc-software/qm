import { deriveKey, seal } from "../../plugins/portal/src/session.ts";

const SECRET = "test-browser-session-secret-0123456789abcdef";

export const browserSessionDeps = {
  portalSession: { secret: SECRET, maxAgeSeconds: 3600 },
  portalUrl: "https://qm.test",
};

export function browserSessionCookie(sub: string, extra: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub, org: "default-org", iat, exp: iat + 3600, ...extra };
  return `portal_session=${encodeURIComponent(seal(claims, deriveKey(SECRET, "portal.session.v1")))}`;
}

export function browserImpersonationCookie(actor: string, target: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { k: "impersonate", actor, target, org: "default-org", iat, exp: iat + 600 };
  return `portal_impersonate=${encodeURIComponent(seal(claims, deriveKey(SECRET, "portal.impersonate.v1")))}`;
}
