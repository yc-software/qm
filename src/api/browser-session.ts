import type { IncomingMessage } from "node:http";
import {
  deriveKey,
  impersonationFor,
  openSession,
  readCookie,
  sessionLifetime,
} from "../../plugins/portal/src/session.ts";
import { originOf, sameOriginRequest } from "../../plugins/chassis/src/http.ts";
import type { PortalIdentity } from "../auth/portal-identity.ts";
import { orgId } from "../config.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import { reportFailure } from "../util/errors.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import type { ServerDeps } from "./deps.ts";
import type { Route } from "./routes/route.ts";
import { activePrincipal } from "./routes/shared.ts";

interface BrowserRefusal {
  status: 401 | 403 | 503;
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

function misconfiguration(deps: ServerDeps, maxAge: number): string | null {
  if (!deps.portalSessionSecret) return "PORTAL_SESSION_SECRET is not set";
  if (!originOf(deps.portalUrl ?? ""))
    return `PUBLIC_WEB_URL is not an absolute URL (got ${JSON.stringify(deps.portalUrl ?? "")})`;
  if (!Number.isFinite(maxAge)) return "PORTAL_SESSION_TTL_S / PORTAL_SESSION_MAX_TTL_S are not finite numbers";
  return null;
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
  const now = Date.now();
  const maxAge = sessionLifetime().max;
  const problem = misconfiguration(deps, maxAge);
  if (problem) {
    reportFailure("browser_session.misconfigured", new Error(problem));
    return { status: 503, error: "unavailable", message: "browser sign-in is not configured on this server" };
  }
  const secret = deps.portalSessionSecret!;
  const cookies = req.headers.cookie;
  const session = openSession(
    readCookie(cookies, "portal_session"),
    deriveKey(secret, "portal.session.v1"),
    now,
    orgId(),
    maxAge,
  );
  if (!session)
    return { status: 401, error: "unauthorized", message: "a sign-in session for this organization is required" };
  if (session.appOnly)
    return { status: 403, error: "app_only_session", message: "this sign-in only permits access to shared apps" };
  if (session.anon) return { status: 403, error: "forbidden", message: "playground sessions cannot call this route" };
  if (method !== "GET" && method !== "HEAD" && !sameOriginRequest(req, originOf(deps.portalUrl!)))
    return { status: 403, error: "forbidden", message: "cross-origin request refused" };
  await deps.identity?.refresh();
  const sub = canonicalPerson(session.sub);
  const imp = impersonationFor({ sub, org: session.org }, cookies, deriveKey(secret, "portal.impersonate.v1"), now);
  const target = imp && (await isAdmin(deps, sub)) ? imp.target : null;
  return {
    p: target ?? sub,
    authenticatedAs: session.sub,
    ...(target ? { imp: sub } : {}),
    ...(!target && session.name ? { n: session.name } : {}),
    exp: session.exp * 1000,
  };
}

export function bindBrowserActor(
  field: Route["actor"],
  req: IncomingMessage,
  url: URL,
  body: unknown,
  principalId: string,
): { body: unknown } | null {
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const foreign = (value: unknown): boolean => typeof value !== "string" || !samePerson(value, principalId);
  if (url.searchParams.getAll("principalId").some(foreign)) return null;
  if (fields && Object.hasOwn(fields, "principalId") && foreign(fields.principalId)) return null;
  const [where, name] = (field ?? "").split(".", 2);
  if (where === "query" && name && !url.searchParams.has(name)) {
    url.searchParams.set(name, principalId);
    req.url = `${url.pathname}${url.search}`;
  }
  if (where === "body" && name && fields && !Object.hasOwn(fields, name))
    return { body: { ...fields, [name]: principalId } };
  return { body };
}
