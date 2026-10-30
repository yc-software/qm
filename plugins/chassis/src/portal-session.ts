import { deriveKey, open } from "./signed-token.ts";

export function portalSessionKey(secret: string): Buffer {
  return deriveKey(secret, "portal.session.v1");
}

export interface SessionClaims {
  k: "session";
  sub: string;
  org: string;
  name?: string;
  auth?: number;
  anon?: boolean;
  appOnly?: boolean;
  iat: number;
  exp: number;
}

export function openSession(
  token: string | null,
  key: Buffer,
  now: number,
  expectedOrg?: string,
  maxAgeSeconds?: number,
): SessionClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "session") return null;
  if (
    typeof p.sub !== "string" ||
    !p.sub ||
    typeof p.org !== "string" ||
    !p.org ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number"
  )
    return null;
  if (p.appOnly !== undefined && typeof p.appOnly !== "boolean") return null;
  if (expectedOrg !== undefined && p.org !== expectedOrg) return null;
  if (now >= p.exp * 1000) return null;
  const authenticatedAt = typeof p.auth === "number" ? p.auth : p.iat;
  if (maxAgeSeconds !== undefined && now >= (authenticatedAt + maxAgeSeconds) * 1000) return null;
  return p as unknown as SessionClaims;
}
