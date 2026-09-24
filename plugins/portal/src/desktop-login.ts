import { createHash } from "node:crypto";
import { deriveKey, open, randomToken, safeEqual, seal, type SessionClaims } from "./session.ts";

export const DESKTOP_LAUNCH_SCRIPT = `window.location.href = document.getElementById("desktop-launch").href;`;
export const DESKTOP_LAUNCH_SCRIPT_HASH = `sha256-${createHash("sha256").update(DESKTOP_LAUNCH_SCRIPT).digest("base64")}`;

export function desktopChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function mintDesktopLogin(
  session: SessionClaims,
  secret: string,
  origin: string,
  challenge: string,
  state: string,
) {
  const now = Math.floor(Date.now() / 1000);
  return seal(
    {
      k: "desktop-login",
      aud: origin,
      sub: session.sub,
      org: session.org,
      name: session.name,
      auth: session.auth ?? session.iat,
      sessionExp: session.exp,
      challenge,
      state,
      iat: now,
      exp: Math.min(now + 120, session.exp),
      jti: randomToken(18),
    },
    deriveKey(secret, "portal.desktop-login.v1"),
  );
}

export function openDesktopLogin(
  code: string,
  verifier: string,
  state: string,
  secret: string,
  origin: string,
  org: string,
  maxAge: number,
  nowMs = Date.now(),
) {
  if (code.length > 8192 || !desktopChallenge(verifier) || !desktopChallenge(state)) return null;
  const p = open(code, deriveKey(secret, "portal.desktop-login.v1"));
  const now = Math.floor(nowMs / 1000);
  if (
    !p ||
    p.k !== "desktop-login" ||
    p.aud !== origin ||
    p.org !== org ||
    typeof p.sub !== "string" ||
    !p.sub ||
    typeof p.auth !== "number" ||
    !Number.isSafeInteger(p.auth) ||
    p.auth > now + 5 ||
    now >= p.auth + maxAge ||
    typeof p.sessionExp !== "number" ||
    !Number.isSafeInteger(p.sessionExp) ||
    p.sessionExp <= now ||
    typeof p.iat !== "number" ||
    !Number.isSafeInteger(p.iat) ||
    p.iat > now + 5 ||
    typeof p.exp !== "number" ||
    !Number.isSafeInteger(p.exp) ||
    p.exp <= now ||
    p.exp <= p.iat ||
    p.exp - p.iat > 120 ||
    typeof p.jti !== "string" ||
    !/^[a-f0-9]{36}$/.test(p.jti) ||
    typeof p.challenge !== "string" ||
    !desktopChallenge(p.challenge) ||
    typeof p.state !== "string" ||
    !safeEqual(state, p.state) ||
    !safeEqual(createHash("sha256").update(verifier).digest("base64url"), p.challenge)
  )
    return null;
  const session: SessionClaims = {
    k: "session",
    sub: p.sub,
    org,
    auth: p.auth,
    iat: now,
    exp: p.sessionExp,
    ...(typeof p.name === "string" ? { name: p.name } : {}),
  };
  return { session, jti: p.jti, expiresAtMs: p.exp * 1000 };
}
