import { createHash } from "node:crypto";
import { deriveKey, open } from "./session.ts";

export function openAdminLogin(token: string, secret: string, publicUrl: string, nowMs = Date.now()) {
  if (secret.trim().length < 32 || token.length > 4096) return null;
  const claims = open(token, deriveKey(secret, "portal.admin-login.v1"));
  if (!claims) return null;
  const { k, sub, aud, iat, exp, jti } = claims;
  const now = Math.floor(nowMs / 1000);
  if (
    k !== "admin-login" ||
    aud !== publicUrl ||
    typeof sub !== "string" ||
    sub.length > 254 ||
    !/^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(sub) ||
    sub !== sub.trim().toLowerCase() ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    iat > now + 5 ||
    exp <= now ||
    exp <= iat ||
    exp - iat > 300 ||
    typeof jti !== "string" ||
    !/^[A-Za-z0-9_-]{24}$/.test(jti)
  )
    return null;
  return { email: sub, jti, expiresAtMs: exp * 1000 };
}

export const ADMIN_LOGIN_SCRIPT = `(function () {
  var token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  try {
    if (!token || token.length > 4096) throw new Error();
    var body = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    var claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), function (c) { return c.charCodeAt(0); })));
    if (typeof claims.sub !== "string") throw new Error();
    document.getElementById("admin-email").textContent = claims.sub;
    document.getElementById("admin-token").value = token;
    document.getElementById("admin-confirm").disabled = false;
  } catch (e) {
    document.getElementById("admin-email").textContent = "This link is missing or invalid. Generate a new link with qm admin-login.";
  }
})();`;

export const ADMIN_LOGIN_SCRIPT_HASH = `sha256-${createHash("sha256").update(ADMIN_LOGIN_SCRIPT).digest("base64")}`;
