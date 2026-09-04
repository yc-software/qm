import { createHmac, timingSafeEqual } from "node:crypto";

export function portalSessionSub(cookieHeader: string | undefined, secret: string, now = Date.now()): string | null {
  for (const token of readCookies(cookieHeader, "portal_session")) {
    const sub = verifySessionToken(token, secret, now);
    if (sub) return sub;
  }
  return null;
}

function verifySessionToken(token: string, secret: string, now: number): string | null {
  const key = createHmac("sha256", secret).update("portal.session.v1").digest();
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let claims: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    claims = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (claims.k !== "session") return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.exp !== "number" || now >= claims.exp * 1000) return null;
  return claims.sub;
}

function readCookies(header: string | undefined, name: string): string[] {
  const out: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const p = part.trim();
    if (!p.startsWith(`${name}=`)) continue;
    try {
      out.push(decodeURIComponent(p.slice(name.length + 1)));
    } catch (error) {
      void error;
    }
  }
  return out;
}
