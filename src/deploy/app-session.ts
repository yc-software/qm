import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";

export const APP_START_PATH = "/__qm/start";
export const APP_LAUNCH_PATH = "/__qm/launch";
export const APP_LAUNCH_TTL_MS = 60_000;
export const APP_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const APP_SESSION_COOKIE = "__Host-qm_app_session";
export const APP_CHALLENGE_COOKIE = "__Host-qm_app_challenge";
export const RESERVED_APP_COOKIE =
  /^(?:__Host-(?:qm_|portal_)[\w-]*|qm_app_session|qm_idp_session|dpl_access|dpl_owner|portal_[\w-]*|webuiuser)\s*=/i;
const localEpoch = randomBytes(32).toString("base64url");

export interface AppAudience {
  orgId: string;
  deploymentId: string;
  origin: string;
}
interface AppClaims extends AppAudience {
  iat: number;
  exp: number;
  version: 1;
}
interface AppReturn {
  sourceOrigin: string;
  path: string;
}
export type AppToken =
  | (AppClaims & AppReturn & { type: "request" })
  | (AppClaims & AppReturn & { type: "challenge"; nonce: string })
  | (AppClaims & AppReturn & { type: "launch"; nonce: string; jti: string; sub: string })
  | (AppClaims & { type: "session"; sub: string });
type AppTokenInput = { [T in AppToken["type"]]: Omit<Extract<AppToken, { type: T }>, "version"> }[AppToken["type"]];

function appKey(secret: string, type: AppToken["type"]): string {
  return createHmac("sha256", secret).update(`qm.deployment.${type}.v1`).digest("base64url");
}

export function localAppKey(secret: string): string {
  return createHmac("sha256", secret).update(`qm.deployment.local.${localEpoch}`).digest("base64url");
}

export function appNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function mintAppSession(secret: string, claims: AppTokenInput): Promise<string> {
  return mintSignedPayload({ ...claims, version: 1 }, appKey(secret, claims.type));
}

export async function verifyAppSession<T extends AppToken["type"]>(
  secret: string,
  token: string,
  type: T,
  audience: AppAudience,
  now = Date.now(),
): Promise<Extract<AppToken, { type: T }> | null> {
  const claims = (await verifySignedPayload(token, appKey(secret, type))) as AppToken | null;
  if (!claims || claims.version !== 1 || claims.type !== type) return null;
  if (
    claims.orgId !== audience.orgId ||
    claims.deploymentId !== audience.deploymentId ||
    claims.origin !== audience.origin
  )
    return null;
  const ttl = type === "session" ? APP_SESSION_TTL_MS : APP_LAUNCH_TTL_MS;
  if (
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp) ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > ttl
  )
    return null;
  if (claims.type === "session" || claims.type === "launch") {
    if (typeof claims.sub !== "string" || !claims.sub.trim()) return null;
  } else if ("sub" in claims) return null;
  if (claims.type !== "session") {
    if (typeof claims.path !== "string" || !safeAppPath(claims.path) || !urlOrigin(claims.sourceOrigin)) return null;
  }
  if (
    (claims.type === "challenge" || claims.type === "launch") &&
    (typeof claims.nonce !== "string" || !/^[\w-]{43}$/.test(claims.nonce))
  )
    return null;
  if (claims.type === "launch" && (typeof claims.jti !== "string" || !/^[\w-]{43}$/.test(claims.jti))) return null;
  return claims as Extract<AppToken, { type: T }>;
}

export function urlOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === raw ? u.origin : null;
  } catch {
    return null;
  }
}

export function safeAppPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x1f\x7f#]/.test(path)) return false;
  let decoded = path.split("?", 1)[0]!;
  for (let i = 0; i < 8; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(next) || next.split("/").some((p) => p === "." || p === ".."))
      return false;
    if (next === decoded) return true;
    decoded = next;
  }
  return false;
}

export function withoutQueryParameter(search: string, name: string): string {
  if (!search) return search;
  const kept = search
    .slice(1)
    .split("&")
    .filter((part) => {
      try {
        return decodeURIComponent(part.split("=", 1)[0]!.replace(/\+/g, " ")) !== name;
      } catch {
        return true;
      }
    });
  return kept.length ? `?${kept.join("&")}` : "";
}

function loopbackAddress(address: string | undefined): boolean {
  const ip = address?.replace(/^::ffff:/i, "") ?? "";
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

export function localAppIngress(req: IncomingMessage, production: boolean | undefined): boolean {
  if (production !== false || !loopbackAddress(req.socket.remoteAddress) || !loopbackAddress(req.socket.localAddress))
    return false;
  try {
    const rawHost = req.headers.host ?? "";
    const host = new URL(`http://${rawHost}`);
    if (host.host !== rawHost.toLowerCase() || host.username || host.password || host.pathname !== "/") return false;
    const hostname = host.hostname;
    if (
      hostname !== "localhost" &&
      !hostname.endsWith(".apps.localhost") &&
      !loopbackAddress(hostname.replace(/^\[|\]$/g, ""))
    )
      return false;
    return Number(host.port || 80) === req.socket.localPort;
  } catch {
    return false;
  }
}
