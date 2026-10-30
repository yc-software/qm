import { openSession, portalSessionKey } from "../../plugins/chassis/src/portal-session.ts";

export const FRAME_SESSION_COOKIE = "portal_session_x";

export interface PortalViewerSession {
  sub: string;
  appOnly: boolean;
}

export function portalSession(
  cookieHeader: string | undefined,
  secret: string,
  now = Date.now(),
): PortalViewerSession | null {
  return portalSessionFrom(cookieHeader, "portal_session", secret, now);
}

export function portalSessionFrom(
  cookieHeader: string | undefined,
  name: string,
  secret: string,
  now = Date.now(),
): PortalViewerSession | null {
  const key = portalSessionKey(secret);
  for (const token of readCookies(cookieHeader, name)) {
    const session = openSession(token, key, now);
    if (session) return { sub: session.sub, appOnly: session.appOnly === true };
  }
  return null;
}

function readCookies(header: string | undefined, name: string): string[] {
  const out: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const p = part.trim();
    if (!p.startsWith(`${name}=`)) continue;
    try {
      out.push(decodeURIComponent(p.slice(name.length + 1)));
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
  }
  return out;
}
