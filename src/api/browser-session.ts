import type { IncomingMessage } from "node:http";
import { deriveKey, impersonationFor, openSession, readCookie } from "../../plugins/portal/src/session.ts";
import { originOf, sameOriginRequest } from "../../plugins/chassis/src/http.ts";
import type { PortalIdentity } from "../auth/portal-identity.ts";
import { isStrongSigningSecret, MIN_SIGNING_SECRET_LENGTH } from "../auth/source-auth.ts";
import { orgId } from "../config.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import { reportFailure } from "../util/errors.ts";
import { bootTenant } from "../tenants/boot.ts";
import { labelOfAppHost } from "../tenants/app-handle.ts";
import type { ServerDeps } from "./deps.ts";
import { apiRoutes } from "./routes/index.ts";
import { compilePath, findRoute, type Route } from "./routes/route.ts";
import { activePrincipal } from "./routes/shared.ts";
import type { Tenant } from "../tenants/context.ts";

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
  ["POST /api/sessions/:id/next-prompt", "/v1/sessions/:id/next-prompt"],
  ["POST /api/sessions/:id/detach", "/v1/sessions/:id/detach"],
  ["POST /api/sessions/:id/goal/cancel", "/v1/sessions/:id/goal/cancel"],
  ["POST /api/sessions/:id/goal/resume", "/v1/sessions/:id/goal/resume"],
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
  ["GET /api/files/by-name/content", "/v1/files/by-name/content"],
  ["GET /api/files/:id/content", "/v1/files/:id/content"],
  ["GET /api/files/:id/content/:name", "/v1/files/:id/content"],
  ["GET /api/playgrounds/:id", "/v1/playgrounds/:id"],
  ["POST /api/turn", "/v1/web/turn"],
  ["POST /api/approvals/:requestId", "/v1/web/approvals/:requestId"],
  ["POST /api/runs/:id/signal", "/v1/web/runs/:id/signal"],
  ["GET /api/deliveries/events", "/v1/web/events"],
  ["GET /me", "/v1/web/me"],
  ["POST /api/runs/:id/withdraw", "/v1/runs/:id/withdraw"],
  ["GET /api/composio/callback", "/v1/composio/callback"],
  ["GET /api/dictation", "/v1/web/dictation"],
  ["POST /api/dictation", "/v1/web/dictation"],
  ["GET /api/voice", "/v1/web/voice"],
  ["POST /api/voice/sessions", "/v1/web/voice/sessions"],
  ["GET /api/ui-canvas/:sessionId", "/v1/ui/canvases/:sessionId"],
  ["GET /api/ui-canvas/:sessionId/script.js", "/v1/ui/canvases/:sessionId/script.js"],
  ["POST /api/ui-canvas/observe/:callId", "/v1/ui/observe/:callId/result"],
  ["POST /api/ui-canvas/:sessionId", "/v1/ui/canvases/:sessionId"],
  ["GET /api/admin/connector-catalog", "/v1/connectors/catalog"],
  ["GET /api/crons", "/v1/crons"],
  ["GET /api/composio/slack", "/v1/composio/slack"],
  ["POST /api/composio/slack/authorize", "/v1/composio/slack/authorize"],
  ["GET /api/composio/toolkits", "/v1/composio/toolkits"],
  ["GET /api/composio/connections", "/v1/composio/connections"],
  ["POST /api/composio/authorize", "/v1/composio/authorize"],
  ["GET /api/contexts/:scope/ambient-policy", "/v1/contexts/:scope/ambient-policy"],
  ["PUT /api/contexts/:scope/ambient-policy", "/v1/contexts/:scope/ambient-policy"],
  ["GET /api/directory/resolve", "/v1/directory/resolve"],
  ["POST /api/suggested-activities", "/v1/suggested-activities"],
  ["POST /api/suggested-activities/dismiss", "/v1/suggested-activities/dismiss"],
  ["POST /api/connectors/:provider/start", "/v1/connectors/oauth/:provider/start"],
  ["GET /api/keychain/overview", "/v1/keychain/overview"],
  ["POST /api/keychain/grants/:id/revoke", "/v1/keychain/grants/:id/revoke"],
  ["POST /api/keychain/drops", "/v1/keychain/drops"],
  ["DELETE /api/keychain/credentials/:id", "/v1/keychain/credentials/:id"],
  ["GET /api/deployments", "/v1/deployments"],
  ["GET /api/deployments/:id", "/v1/deployments/:id"],
  ["GET /api/deployments/:id/share", "/v1/deployments/:id/share"],
  ["POST /api/deployments/:id/share", "/v1/deployments/:id/share"],
  ["POST /api/deployments/:id/display-name", "/v1/deployments/:id/display-name"],
  ["POST /api/deployments/:id/name", "/v1/deployments/:id/name"],
  ["POST /api/deployments/:id/embed-ancestors", "/v1/deployments/:id/embed-ancestors"],
  ["POST /api/deployments/:id/archive", "/v1/deployments/:id/archive"],
  ["POST /api/deployments/:id/restore", "/v1/deployments/:id/restore"],
  ["POST /api/webhooks", "/v1/webhooks"],
  ["POST /api/webhooks/:id/disable", "/v1/webhooks/:id/disable"],
  ["POST /api/webhooks/:id/enable", "/v1/webhooks/:id/enable"],
  ["POST /api/blobs", "/v1/web/blobs"],
  ["POST /api/files/upload", "/v1/files/upload"],
  ["GET /api/inbox", "/v1/inbox"],
  ["POST /api/inbox/selection", "/v1/inbox/selection"],
  ["POST /api/inbox/sent-chat", "/v1/loops/inbox/sent-chat"],
  ["POST /api/inbox/sync-cron", "/v1/loops/inbox/sync-cron"],
  ["GET /api/inbox/sent", "/v1/connectors/gmail/sent"],
  ["GET /api/inbox/sent/:messageId", "/v1/connectors/gmail/sent/:messageId"],
  ["GET /api/loops", "/v1/loops"],
  ["POST /api/loops", "/v1/loops"],
  ["GET /api/loops/:id", "/v1/loops/:id"],
  ["PATCH /api/loops/:id", "/v1/loops/:id"],
  ["DELETE /api/loops/:id", "/v1/loops/:id"],
  ["GET /api/loops/:id/ingestion", "/v1/loops/:id/ingestion"],
  ["POST /api/loops/:id/ingestion", "/v1/loops/:id/ingestion"],
  ["PATCH /api/loops/:id/ingestion/:sourceId", "/v1/loops/:id/ingestion/:sourceId"],
  ["POST /api/loops/:id/fire", "/v1/loops/:id/fire"],
  ["POST /api/loops/:id/triage/preview", "/v1/loops/:id/triage/preview"],
  ["POST /api/loops/:id/outputs/:outputId/decide", "/v1/loops/:id/outputs/:outputId/decide"],
  ["POST /api/loops/:id/grants", "/v1/loops/:id/grants"],
  ["POST /api/loops/:id/autopilot", "/v1/loops/:id/autopilot"],
  ["GET /api/loops/:id/items", "/v1/loops/:id/items"],
  ["GET /api/loops/:id/items/:itemId", "/v1/loops/:id/items/:itemId"],
  ["GET /api/loops/:id/items/:itemId/image", "/v1/loops/:id/items/:itemId/image"],
  ["POST /api/loops/:id/items/:itemId/action", "/v1/loops/:id/items/:itemId/action"],
  ["POST /api/loops/:id/items/:itemId/followup", "/v1/loops/:id/items/:itemId/followup"],
  ["GET /share/internal/:token", "/v1/web/shares/internal/:token"],
  ["GET /share/external/:token", "/v1/web/shares/external/:token"],
  ["GET /share/internal/:token/files/:fileId", "/v1/shared-sessions/:token/files/:fileId"],
  ["GET /share/external/:token/files/:fileId", "/v1/public-shares/:token/files/:fileId"],
  ...apiRoutes.flatMap((route): Array<[string, string]> =>
    "path" in route && route.browser && route.path.startsWith("/v1/admin/")
      ? [[`${route.method} /api/admin/${route.path.slice("/v1/admin/".length)}`, route.path]]
      : [],
  ),
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
    const route = findRoute(apiRoutes, method, target)?.route;
    return route?.browser || route?.auth === "public" ? target : null;
  }
  return null;
}

export function appHostRequest(
  req: IncomingMessage,
  deps: Pick<ServerDeps, "deployAppsDomain" | "deployGateSecret">,
): boolean {
  if (req.headers["x-qm-app-host"] === "1") return true;
  return !!deps.deployGateSecret && labelOfAppHost(req.headers.host, deps.deployAppsDomain) !== undefined;
}

export function sessionCookieTenant(req: IncomingMessage, secret: string, maxAgeSeconds: number): string | undefined {
  return openSession(
    readCookie(req.headers.cookie, "portal_session"),
    deriveKey(secret, "portal.session.v1"),
    Date.now(),
    orgId(),
    maxAgeSeconds,
  )?.t;
}

export function browserSessionTenant(req: IncomingMessage, deps: BrowserLaneDeps): string | undefined {
  if (misconfiguration(deps)) return undefined;
  return sessionCookieTenant(req, deps.portalSession!.secret, deps.portalSession!.maxAgeSeconds);
}

const RELAY_IDENTITY_HEADERS = ["x-admin-actor", "x-as-principal", "x-consent-clicker", "x-drop-owner"];

interface BrowserRefusal {
  status: 401 | 403 | 503;
  error: string;
  message: string;
}

type BrowserLaneDeps = Pick<ServerDeps, "portalSession" | "signingSecret" | "portalUrl">;

function misconfiguration(deps: BrowserLaneDeps): string | null {
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

async function isAdmin(deps: ServerDeps, tenant: Tenant | undefined, principalId: string): Promise<boolean> {
  if (!deps.admin || !(await activePrincipal(deps, principalId))) return false;
  if (!tenant) throw new Error("No tenant is bound to this request");
  return (await deps.admin.adminStatusOf(tenant, { id: principalId, type: "internal" })).isAdmin;
}

export async function browserIdentity(
  req: IncomingMessage,
  method: string,
  deps: ServerDeps,
  embeddable: boolean,
  tenant: Tenant | undefined,
): Promise<PortalIdentity | BrowserRefusal> {
  const now = Date.now();
  const problem = misconfiguration(deps);
  if (problem) {
    reportFailure("browser_session.misconfigured", new Error(problem));
    return { status: 503, error: "unavailable", message: "browser sign-in is not configured on this server" };
  }
  const { secret, maxAgeSeconds, apiOrigins } = deps.portalSession!;
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
  if ((session.t ?? bootTenant()) !== tenant?.id)
    return { status: 401, error: "unauthorized", message: "a sign-in session for this organization is required" };
  if (session.appOnly)
    return { status: 403, error: "app_only_session", message: "this sign-in only permits access to shared apps" };
  const listedOrigin =
    embeddable && typeof req.headers.origin === "string" && apiOrigins?.has(req.headers.origin) === true;
  if (method !== "GET" && method !== "HEAD" && !listedOrigin && !sameOriginRequest(req, originOf(deps.portalUrl!)))
    return { status: 403, error: "forbidden", message: "cross-origin request refused" };
  for (const header of RELAY_IDENTITY_HEADERS) delete req.headers[header];
  await deps.identity?.refresh();
  const sub = canonicalPerson(session.sub);
  const foreign = req.headers.origin !== undefined && !sameOriginRequest(req, originOf(deps.portalUrl!));
  const imp = foreign
    ? null
    : impersonationFor({ sub, org: session.org }, cookies, deriveKey(secret, "portal.impersonate.v1"), now);
  const target = imp && (await isAdmin(deps, tenant, sub)) ? imp.target : null;
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
