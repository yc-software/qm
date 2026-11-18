import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../../chassis/src/http.ts";
import {
  openImpersonation,
  readCookie,
  seal,
  setCookie,
  clearCookie,
  type SessionClaims,
  type ImpersonationClaims,
} from "./session.ts";

export const DEVELOPMENT_IMPERSONATION_PATH = "/api/development/impersonation";
export const DEVELOPMENT_VIEW = "development_view";
export const DEVELOPMENT_IMPERSONATING = "development_impersonating";

export async function developmentImpersonation(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  session: SessionClaims | null;
  enabled: boolean;
  allowedOrigin: boolean;
  key: Buffer;
  secure: boolean;
  ttlSeconds: number;
  isAdmin: (session: SessionClaims) => Promise<boolean>;
  canonical: (target: string, session: SessionClaims) => Promise<string | null>;
  impersonate: (
    action: "start" | "stop",
    session: SessionClaims,
    target: string,
  ) => Promise<{ ok: boolean; status: number; displayName?: string; message?: string }>;
}): Promise<boolean> {
  const { req, res, url, session } = input;
  const endpoint = url.pathname === DEVELOPMENT_IMPERSONATION_PATH;
  const view = url.searchParams.get(DEVELOPMENT_VIEW);
  if (!endpoint && view === null) return false;
  res.setHeader("cache-control", "no-store");
  const refuse = (status: number, error: string) => {
    json(res, status, { error });
    return true;
  };
  if (!input.enabled) return refuse(404, "not_found");
  if (!view || !input.allowedOrigin) return refuse(403, "forbidden");
  if (!session) return refuse(401, "sign_in");
  if (!(await input.isAdmin(session))) return refuse(403, "admin_required");
  const drivers = url.searchParams.getAll("driver");
  if (drivers.length) {
    let matches = false;
    for (const candidate of drivers) {
      if (candidate === session.sub || (await input.canonical(candidate, session)) === session.sub) {
        matches = true;
        break;
      }
    }
    if (!matches) return refuse(409, "driver_identity_mismatch");
  }
  const name = `portal_development_${createHash("sha256").update(view).digest("hex")}`;
  const raw = readCookie(req.headers.cookie, name);
  const selected = openImpersonation(raw, input.key, Date.now());
  const valid = selected && selected.actor === session.sub && selected.org === session.org ? selected : null;
  const impersonating = url.searchParams.get(DEVELOPMENT_IMPERSONATING) === "1";
  if (req.method === "GET" && impersonating && !valid) return refuse(401, "test_identity_expired");
  if (endpoint) {
    if (req.method === "GET") {
      json(res, 200, { enabled: true, actor: session.sub, target: impersonating ? valid!.target : session.sub });
      return true;
    }
    if (req.method !== "POST") return refuse(405, "method_not_allowed");
    const requested = url.searchParams.getAll("target");
    let target: string | null = requested.length ? null : session.sub;
    for (const candidate of requested) {
      target = candidate === session.sub ? session.sub : await input.canonical(candidate, session);
      if (target) break;
    }
    if (!target) return refuse(400, "invalid_target");
    if (target === session.sub) {
      if (valid) await input.impersonate("stop", session, valid.target);
      res.appendHeader("set-cookie", clearCookie(name, "/", input.secure));
      json(res, 200, { enabled: true, actor: session.sub, target: session.sub });
      return true;
    }
    const result = await input.impersonate("start", session, target);
    if (!result.ok) return refuse(result.status === 403 ? 403 : 400, "impersonation_refused");
    const now = Math.floor(Date.now() / 1000);
    const claims: ImpersonationClaims = {
      k: "impersonate",
      actor: session.sub,
      target,
      org: session.org,
      iat: now,
      exp: now + input.ttlSeconds,
    };
    res.appendHeader(
      "set-cookie",
      setCookie(name, seal(claims, input.key), { path: "/", maxAge: input.ttlSeconds, secure: input.secure }),
    );
    json(res, 200, { enabled: true, actor: session.sub, target, displayName: result.displayName ?? target });
    return true;
  }
  if (impersonating && !valid) return refuse(401, "test_identity_expired");
  const cookies = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("portal_impersonate="));
  if (impersonating && valid) cookies.push(`portal_impersonate=${encodeURIComponent(raw!)}`);
  req.headers.cookie = cookies.join("; ");
  return false;
}
