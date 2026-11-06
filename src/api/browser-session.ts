import type { IncomingMessage } from "node:http";
import {
  deriveKey,
  openImpersonation,
  openSession,
  readCookie,
  sessionLifetime,
} from "../../plugins/portal/src/session.ts";
import { sameOriginRequest } from "../../plugins/chassis/src/http.ts";
import type { PortalIdentity } from "../auth/portal-identity.ts";
import { orgId } from "../config.ts";
import { canonicalPerson } from "../directory/person.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import type { ServerDeps } from "./deps.ts";
import type { Route } from "./routes/route.ts";
import { activePrincipal } from "./routes/shared.ts";

interface BrowserRefusal {
  status: 401 | 403;
  error: string;
  message: string;
}

export function usesBrowserSession(req: IncomingMessage, route: Pick<Route, "browser"> | undefined): boolean {
  return (
    route?.browser === true &&
    req.headers[CAPABILITY_HEADER] === undefined &&
    req.headers["x-signature"] === undefined &&
    readCookie(req.headers.cookie, "portal_session") !== null
  );
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

async function isAdmin(deps: ServerDeps, principalId: string): Promise<boolean> {
  if (!deps.admin || !(await activePrincipal(deps, principalId))) return false;
  return (await deps.admin.adminStatusOf({ id: principalId, type: "internal" })).isAdmin;
}

export async function browserIdentity(
  req: IncomingMessage,
  method: string,
  deps: ServerDeps,
): Promise<PortalIdentity | BrowserRefusal> {
  const secret = deps.portalSessionSecret;
  const now = Date.now();
  const maxAge = sessionLifetime().max;
  const session = secret
    ? openSession(
        readCookie(req.headers.cookie, "portal_session"),
        deriveKey(secret, "portal.session.v1"),
        now,
        orgId(),
        Number.isFinite(maxAge) ? maxAge : 0,
      )
    : null;
  if (!secret || !session)
    return { status: 401, error: "unauthorized", message: "a sign-in session for this organization is required" };
  if (session.appOnly)
    return { status: 403, error: "app_only_session", message: "this sign-in only permits access to shared apps" };
  if (session.anon) return { status: 403, error: "forbidden", message: "playground sessions cannot call this route" };
  if (method !== "GET" && method !== "HEAD" && !sameOriginRequest(req, originOf(deps.portalUrl)))
    return { status: 403, error: "forbidden", message: "cross-origin request refused" };
  await deps.identity?.refresh();
  const sub = canonicalPerson(session.sub);
  const imp = openImpersonation(
    readCookie(req.headers.cookie, "portal_impersonate"),
    deriveKey(secret, "portal.impersonate.v1"),
    now,
  );
  const target = imp && imp.actor === sub && imp.org === session.org && (await isAdmin(deps, sub)) ? imp.target : null;
  return {
    p: target ?? sub,
    authenticatedAs: session.sub,
    ...(target ? { imp: sub } : {}),
    ...(!target && session.name ? { n: session.name } : {}),
    exp: session.exp * 1000,
  };
}
