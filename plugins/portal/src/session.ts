import { randomBytes } from "node:crypto";
import { open } from "../../chassis/src/signed-token.ts";

export interface ImpersonationClaims {
  k: "impersonate";
  actor: string;
  target: string;
  org: string;
  iat: number;
  exp: number;
}

export interface TmpClaims {
  k: "tmp";
  state: string;
  nonce: string;
  pkceVerifier: string;
  returnTo: string;
  iat: number;
  exp: number;
}

export function openImpersonation(token: string | null, key: Buffer, now: number): ImpersonationClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "impersonate") return null;
  if (typeof p.actor !== "string" || !p.actor) return null;
  if (typeof p.target !== "string" || !p.target) return null;
  if (typeof p.org !== "string" || typeof p.exp !== "number") return null;
  if (now >= p.exp * 1000) return null;
  return p as unknown as ImpersonationClaims;
}

export function openTmp(token: string | null, key: Buffer, now: number): TmpClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "tmp") return null;
  if (
    typeof p.state !== "string" ||
    typeof p.nonce !== "string" ||
    typeof p.pkceVerifier !== "string" ||
    typeof p.exp !== "number"
  )
    return null;
  if (now >= p.exp * 1000) return null;
  return p as unknown as TmpClaims;
}

export interface CookieOpts {
  path?: string;
  maxAge?: number;
  secure: boolean;
  domain?: string;
  sameSite?: "Lax" | "None";
}

export function setCookie(name: string, value: string, opts: CookieOpts): string {
  const sameSite = opts.sameSite === "None" && opts.secure ? "None" : "Lax";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Path=${opts.path ?? "/"}`,
  ];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export function clearCookie(name: string, path: string, secure: boolean, domain?: string): string {
  const parts = [`${name}=`, "HttpOnly", "SameSite=Lax", `Path=${path}`, "Max-Age=0"];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookieHeaders(value: string, attrs: CookieOpts): string[] {
  return [
    setCookie("portal_session", value, attrs),
    setCookie("portal_session_x", value, { ...attrs, sameSite: "None" }),
    ...(attrs.domain
      ? [
          clearCookie("portal_session", attrs.path ?? "/", attrs.secure),
          clearCookie("portal_session_x", attrs.path ?? "/", attrs.secure),
        ]
      : []),
  ];
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = header.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

function sanitizeAppsReturnTo(value: string, appsDomain: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const suffix = `.${appsDomain.toLowerCase()}`;
  if (!u.hostname.endsWith(suffix)) return null;
  const slug = u.hostname.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) return null;
  return `${u.origin}${u.pathname}${u.search}`;
}

export function sanitizeReturnTo(value: string | null | undefined, publicOrigin: string, appsDomain?: string): string {
  if (value && appsDomain) {
    const apps = sanitizeAppsReturnTo(value, appsDomain);
    if (apps) return apps;
  }
  if (!value || value[0] !== "/") return "/";
  if (value.startsWith("//")) return "/";
  if (/[\\\x00-\x1f]/.test(value)) return "/";
  if (/%2f%2f|%5c/i.test(value.split(/[?#]/, 1)[0]!)) return "/";
  try {
    const base = new URL(publicOrigin).origin;
    const u = new URL(value, base);
    if (u.origin !== base || u.pathname.startsWith("//")) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}
