import type { IncomingMessage } from "node:http";
import { deriveKey, impersonationFor, openSession, readCookie } from "../../plugins/portal/src/session.ts";
import { originOf, sameOriginRequest } from "../../plugins/chassis/src/http.ts";
import type { PortalIdentity } from "../auth/portal-identity.ts";
import { isStrongSigningSecret, MIN_SIGNING_SECRET_LENGTH } from "../auth/source-auth.ts";
import { orgId } from "../config.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import { reportFailure } from "../util/errors.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import type { ServerDeps } from "./deps.ts";
import { apiRoutes } from "./routes/index.ts";
import { compilePath, findRoute, type Route } from "./routes/route.ts";
import { activePrincipal } from "./routes/shared.ts";

export const API_ALIASES: ReadonlyMap<string, string> = new Map([
  ["GET /api/sessions", "/v1/sessions"],
  ["GET /api/sessions/row", "/v1/sessions/row"],
  ["GET /api/sessions/:id/children", "/v1/sessions/:id/children"],
  ["GET /api/sessions/:id/side-chats", "/v1/sessions/:id/side-chats"],
  ["GET /api/sessions/:id/approvals", "/v1/sessions/:id/approvals"],
  ["GET /api/sessions/:id/background", "/v1/sessions/:id/background"],
  ["GET /api/sessions/:id/background/:pid/output", "/v1/sessions/:id/background/:pid/output"],
  ["GET /api/sessions/:id/items/:seq", "/v1/sessions/:id/items/:seq"],
  ["GET /api/sessions/:id", "/v1/sessions/:id"],
  ["GET /api/search", "/v1/sessions/search"],
  ["GET /api/resources/search", "/v1/resources/search"],
  ["GET /api/contexts", "/v1/contexts"],
  ["GET /api/scope-resources", "/v1/scope-resources"],
  ["GET /api/personas", "/v1/personas"],
  ["GET /api/personas/:id", "/v1/personas/:id"],
  ["GET /api/personas/:id/versions", "/v1/personas/:id/versions"],
  ["GET /api/skills", "/v1/skills"],
  ["GET /api/skills/:id", "/v1/skills/:id"],
  ["GET /api/memory", "/v1/memory"],
  ["GET /api/spend", "/v1/spend"],
  ["GET /api/files", "/v1/files"],
  ["GET /api/webhooks", "/v1/webhooks"],
  ["GET /api/webhooks/:id/events", "/v1/webhooks/:id/events"],
  ["GET /api/user-model-auth/status", "/v1/user-model-auth/status"],
  ["GET /api/connectors", "/v1/connectors/oauth/status"],
  ["GET /api/directory/channels", "/v1/directory/channels"],
  ["GET /api/ui-state", "/v1/ui-state"],
  ["GET /api/custom-emoji", "/v1/custom-emoji"],
  ["GET /api/crons/:id/runs", "/v1/crons/:id/runs"],
  ["GET /api/runs/active", "/v1/runs"],
  ["GET /api/runs/:id/events", "/v1/runs/:id/events"],
  ["GET /api/runs/:id", "/v1/runs/:id"],
  ["POST /api/user-model-auth/account", "/v1/user-model-auth/account"],
  ["POST /api/user-model-auth/api-key", "/v1/user-model-auth/api-key"],
  ["POST /api/user-model-auth/disconnect", "/v1/user-model-auth/disconnect"],
  ["POST /api/user-model-auth/chatgpt/start", "/v1/user-model-auth/chatgpt/start"],
  ["POST /api/user-model-auth/chatgpt/poll", "/v1/user-model-auth/chatgpt/poll"],
  ["POST /api/user-model-auth/claude/start", "/v1/user-model-auth/claude/start"],
  ["POST /api/user-model-auth/claude/complete", "/v1/user-model-auth/claude/complete"],
  ["POST /api/composio/slack/reply-status", "/v1/composio/slack/reply-status"],
  ["POST /api/composio/slack/reply", "/v1/composio/slack/reply"],
  ["POST /api/composio/slack/complete", "/v1/composio/slack/complete"],
  ["POST /api/composio/disconnect", "/v1/composio/disconnect"],
  ["POST /api/projects", "/v1/projects"],
  ["PATCH /api/projects/:id", "/v1/projects/:id"],
  ["POST /api/projects/:id/members", "/v1/projects/:id/members"],
  ["DELETE /api/projects/:id/members/:memberId", "/v1/projects/:id/members/:memberId"],
  ["PUT /api/projects/:id/slack-channel", "/v1/projects/:id/slack-channel"],
  ["DELETE /api/projects/:id/slack-channel", "/v1/projects/:id/slack-channel"],
  ["POST /api/personas", "/v1/personas"],
  ["PATCH /api/personas/:id", "/v1/personas/:id"],
  ["DELETE /api/personas/:id", "/v1/personas/:id"],
  ["PUT /api/personas/:id/access", "/v1/personas/:id/access"],
  ["POST /api/personas/:id/versions/:version/restore", "/v1/personas/:id/versions/:version/restore"],
  ["POST /api/sessions", "/v1/sessions"],
  ["POST /api/sessions/:id", "/v1/sessions/:id"],
  ["PUT /api/sessions/:id/persona", "/v1/sessions/:id/persona"],
  ["POST /api/sessions/:id/share", "/v1/sessions/:id/share"],
  ["POST /api/sessions/:id/title", "/v1/sessions/:id/title"],
  ["POST /api/sessions/:id/detach", "/v1/sessions/:id/detach"],
  ["POST /api/sessions/:id/goal/cancel", "/v1/sessions/:id/goal/cancel"],
  ["POST /api/sessions/:id/expand", "/v1/sessions/:id/expand"],
  ["POST /api/sessions/:id/fork", "/v1/sessions/:id/fork"],
  ["PUT /api/ui-state", "/v1/ui-state"],
  ["POST /api/skills", "/v1/skills"],
  ["PUT /api/skills/:id", "/v1/skills/:id"],
  ["DELETE /api/skills/:id", "/v1/skills/:id"],
  ["POST /api/skills/:id/restore", "/v1/skills/:id/restore"],
  ["PATCH /api/memory", "/v1/memory"],
  ["DELETE /api/memory", "/v1/memory"],
  ["POST /api/connectors/revoke", "/v1/connectors/oauth/revoke"],
  ["POST /api/keychain/approvals/:id", "/v1/keychain/approvals/:id"],
  ["PATCH /api/runs/:id/input", "/v1/runs/:id/input"],
  ["POST /api/crons/:id/disable", "/v1/crons/:id/disable"],
  ["POST /api/crons/:id/run", "/v1/crons/:id/run"],
  ["POST /api/crons/:id/enable", "/v1/crons/:id/enable"],
  ["PATCH /api/crons/:id", "/v1/crons/:id"],
  ["DELETE /api/crons/:id", "/v1/crons/:id"],
  ["GET /api/sessions/:id/swarm", "/v1/sessions/:id/swarm"],
  ["POST /api/sessions/:id/swarm", "/v1/sessions/:id/swarm"],
  ["GET /api/runtime-config", "/v1/runtime-config"],
  ["PUT /api/runtime-config", "/v1/runtime-config"],
  ["GET /api/channel-header-pin", "/v1/channel-header-pin"],
  ["PUT /api/channel-header-pin", "/v1/channel-header-pin"],
  ["POST /api/personas/:id/credentials", "/v1/personas/:id/credentials"],
  ["DELETE /api/personas/:id/credentials/:grantId", "/v1/personas/:id/credentials/:grantId"],
]);

const aliasMatchers = [...API_ALIASES].map(([key, target]) => {
  const [method, path] = key.split(" ", 2) as [string, string];
  return { method, path: compilePath(path), target: target.split("/") };
});

export function apiAlias(method: string, pathname: string): string | null {
  for (const alias of aliasMatchers) {
    const params: Record<string, string> = {};
    if (alias.method !== method || !alias.path.test(method, pathname, params)) continue;
    const target = alias.target
      .map((seg) => (seg.startsWith(":") ? encodeURIComponent(params[seg.slice(1)]!) : seg))
      .join("/");
    return findRoute(apiRoutes, method, target)?.route.browser ? target : null;
  }
  return null;
}

const RELAY_IDENTITY_HEADERS = ["x-admin-actor", "x-as-principal", "x-consent-clicker", "x-drop-owner"];

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

function misconfiguration(deps: ServerDeps): string | null {
  const secret = deps.portalSession?.secret;
  if (!secret?.trim()) return "PORTAL_SESSION_SECRET is not set";
  if (!isStrongSigningSecret(secret))
    return `PORTAL_SESSION_SECRET is shorter than ${MIN_SIGNING_SECRET_LENGTH} characters`;
  if (secret.trim() === deps.signingSecret) return "PORTAL_SESSION_SECRET must differ from CORE_SIGNING_SECRET";
  if (!originOf(deps.portalUrl ?? ""))
    return `PUBLIC_WEB_URL is not an absolute URL (got ${JSON.stringify(deps.portalUrl ?? "")})`;
  if (!Number.isFinite(deps.portalSession?.maxAgeSeconds))
    return "PORTAL_SESSION_TTL_S / PORTAL_SESSION_MAX_TTL_S are not finite numbers";
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
  const problem = misconfiguration(deps);
  if (problem) {
    reportFailure("browser_session.misconfigured", new Error(problem));
    return { status: 503, error: "unavailable", message: "browser sign-in is not configured on this server" };
  }
  const { secret, maxAgeSeconds, principals = [] } = deps.portalSession!;
  const cookies = req.headers.cookie;
  const session = openSession(
    readCookie(cookies, "portal_session"),
    deriveKey(secret, "portal.session.v1"),
    now,
    orgId(),
    maxAgeSeconds,
  );
  if (!session)
    return { status: 401, error: "unauthorized", message: "a sign-in session for this organization is required" };
  if (session.appOnly)
    return { status: 403, error: "app_only_session", message: "this sign-in only permits access to shared apps" };
  if (method !== "GET" && method !== "HEAD" && !sameOriginRequest(req, originOf(deps.portalUrl!)))
    return { status: 403, error: "forbidden", message: "cross-origin request refused" };
  for (const header of RELAY_IDENTITY_HEADERS) delete req.headers[header];
  await deps.identity?.refresh();
  const sub = canonicalPerson(session.sub);
  const foreign = req.headers.origin !== undefined && !sameOriginRequest(req, originOf(deps.portalUrl!));
  const imp = foreign
    ? null
    : impersonationFor({ sub, org: session.org }, cookies, deriveKey(secret, "portal.impersonate.v1"), now);
  const target = imp && (await isAdmin(deps, sub)) ? imp.target : null;
  if (principals.length > 0 && !principals.includes(target ?? sub))
    return { status: 403, error: "forbidden", message: "this person is not on this server's web app allowlist" };
  return {
    p: target ?? sub,
    authenticatedAs: session.sub,
    ...(target ? { imp: sub } : {}),
    ...(!target && session.name ? { n: session.name } : {}),
    exp: session.exp * 1000,
  };
}

export function withBrowserActor(
  field: Route["actor"],
  req: IncomingMessage,
  url: URL,
  body: unknown,
  principalId: string,
): unknown {
  const [where, name] = (field ?? "").split(".", 2);
  const own = (values: unknown[]) =>
    values.every((value) => typeof value === "string" && samePerson(value, principalId));
  if (where === "query" && name && own(url.searchParams.getAll(name))) {
    url.searchParams.set(name, principalId);
    req.url = `${url.pathname}${url.search}`;
  }
  if (where === "body" && name && body && typeof body === "object" && !Array.isArray(body)) {
    if (own(Object.hasOwn(body, name) ? [(body as Record<string, unknown>)[name]] : []))
      return { ...body, [name]: principalId };
  }
  return body;
}
