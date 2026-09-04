import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function deriveKey(secret: string, label: string): Buffer {
  return createHmac("sha256", secret).update(label).digest();
}

export function seal(payload: unknown, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function open(token: string | null | undefined, key: Buffer): Record<string, unknown> | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface SessionClaims {
  k: "session";
  sub: string;
  org: string;
  name?: string;
  auth?: number;
  anon?: boolean;
  iat: number;
  exp: number;
}

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
  if (expectedOrg !== undefined && p.org !== expectedOrg) return null;
  if (now >= p.exp * 1000) return null;
  const authenticatedAt = typeof p.auth === "number" ? p.auth : p.iat;
  if (maxAgeSeconds !== undefined && now >= (authenticatedAt + maxAgeSeconds) * 1000) return null;
  return p as unknown as SessionClaims;
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
}

export function setCookie(name: string, value: string, opts: CookieOpts): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "HttpOnly", "SameSite=Lax", `Path=${opts.path ?? "/"}`];
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

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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
  if (/%2f%2f|%5c/i.test(value)) return "/";
  try {
    const base = new URL(publicOrigin).origin;
    const u = new URL(value, base);
    if (u.origin !== base) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}
