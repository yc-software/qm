import { type IncomingMessage, type ServerResponse } from "node:http";
import { json } from "../../chassis/src/http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

import { portalIdentitySecret } from "../../chassis/src/env.ts";

const ALLOW = (process.env.WEB_UI_PRINCIPALS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export interface Identity {
  user: string;
  name: string | null;
  impersonator: string | null;
}

type Denial = "unauthenticated" | "not_allowed";

function authenticate(req: IncomingMessage): { identity: Identity } | { denied: Denial } {
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const secret = portalIdentitySecret();
  const claims = token && secret ? verifyPortalIdentity(token, secret, Date.now()) : null;
  if (!claims?.p) return { denied: "unauthenticated" };
  if (ALLOW.length > 0 && !ALLOW.includes(claims.p)) return { denied: "not_allowed" };
  return { identity: { user: claims.p, name: claims.n?.trim() || null, impersonator: claims.imp ?? null } };
}

export function resolveIdentity(req: IncomingMessage): Identity | null {
  const outcome = authenticate(req);
  return "identity" in outcome ? outcome.identity : null;
}

export function cookieUser(req: IncomingMessage): string | null {
  return resolveIdentity(req)?.user ?? null;
}

export function unauthorized(res: ServerResponse, req: IncomingMessage): void {
  const outcome = authenticate(req);
  const denied = "denied" in outcome ? outcome.denied : "unauthenticated";
  return json(res, 401, { error: "sign in", reason: denied });
}
