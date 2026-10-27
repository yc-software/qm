import { surfaceHas } from "../surfaces/surface.ts";
import { externalSlackCapabilityAllowed } from "./external-slack-capability.ts";
import { CREDENTIAL_HTTP_BROKER_PREFIX } from "./credential-http-broker.ts";
import { MemoryDisclosureDenied } from "../memory/disclosure.ts";
import { MemoryFactsMissing } from "../memory/facts.ts";
import { nameRequest, reportBackendError } from "../../plugins/chassis/src/error-reporting.ts";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { App } from "./app.ts";
import type { ServerDeps } from "./deps.ts";
import { createControlService } from "./control-service.ts";
import {
  createSourceAuth,
  isStrongSigningSecret,
  MIN_SIGNING_SECRET_LENGTH,
  SOURCE_AUTH_REPLAY_WINDOW_MS,
  type SourceAuth,
} from "../auth/source-auth.ts";
import { verifyCapabilityToken, CONTROL_PLANE_AUD, type CapabilityClaims } from "../auth/capability-token.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER, type PortalIdentity } from "../auth/portal-identity.ts";
import { errMessage } from "../util/errors.ts";
import { parseScopeId } from "../types.ts";
import { canonicalPayload } from "../../plugins/chassis/src/source-auth-sign.ts";
import { armBodyDeadline, HttpError, PayloadTooLargeError, readRawBody, sendJson, verifyOrReject } from "./http.ts";
import { KeychainError } from "../credentials/keychain.ts";
import { BackgroundOwnershipConflict } from "../runs/background-ownership.ts";
import { ByteSourceTooLargeError } from "../files/durable-byte-store.ts";
import { createRouter, run, type AdminAccess, type BaseCtx, type Route } from "./routes/route.ts";
import { apiRoutes, rawRoutes } from "./routes/index.ts";
import { proxyDeploymentSubdomain } from "./routes/deployment-subdomain.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { livePersonCapability } from "./artifact-share.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import { foreignTenant } from "../tenants/directory.ts";
import { InstructionsTooLargeError } from "../resolution/config-instructions.ts";
import { zodMessage } from "./routes/shared.ts";

async function capabilityAdminDenied(
  access: AdminAccess,
  params: Record<string, string>,
  url: URL,
  claims: CapabilityClaims,
): Promise<string | null> {
  if (access.agent === "anyone") return null;
  if (claims.aud !== CONTROL_PLANE_AUD) return "admin routes require the per-turn agent token";
  if (!livePersonCapability(claims) && !(access.unattended && claims.grants?.includes(access.unattended.grant))) {
    return access.unattended
      ? `admin actions through the agent require a turn the admin started themselves — this autonomous run lacks the unattended grant ${access.unattended.grant}, which only a cron's org-admin owner can add, from a live turn in their own DM. Report this failure where the run delivers instead of finishing silently.`
      : "admin actions through the agent require a turn the admin started themselves — autonomous turns (crons, webhooks) cannot use this route. Report this failure where the run delivers instead of finishing silently.";
  }
  if (typeof access.agent === "object") return access.agent.portalOnly;
  if (access.privateRead && parseScopeId(claims.scopeId).kind !== "personal") {
    const target =
      access.privateRead === "unless-org-scope" ? (params.scope ?? url.searchParams.get("scope") ?? "") : "";
    if (parseScopeId(target).kind !== "org" && !livePersonCapability(claims)) {
      return "this admin read returns private content — ask the agent in a DM";
    }
  }
  return null;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function needlessEscape(escaped: string): boolean {
  const char = String.fromCharCode(Number.parseInt(escaped.slice(0, 2), 16));
  return encodeURIComponent(char) === char;
}

function canonicalPath(req: IncomingMessage, pathname: string): boolean {
  return (req.url ?? "/").split("?", 1)[0] === pathname && !pathname.split("%").slice(1).some(needlessEscape);
}

function capabilityFromHeaders(req: IncomingMessage): string | null {
  const h = req.headers[CAPABILITY_HEADER];
  return typeof h === "string" && h ? h : null;
}

function bearerFromHeaders(req: IncomingMessage): string | null {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return bearer?.[1] ?? null;
}

interface GateResult {
  body: unknown;
  capability: CapabilityClaims | null;
  actor: PortalIdentity | null;
  caller: string | null;
}

interface Wiring {
  app: App;
  deps: ServerDeps;
  secret: string | undefined;
  auth: SourceAuth | null;
  requirePortalIdentity: boolean;
  allowUnsignedSourceAuth: boolean;
}

const REFUSAL_ERRORS = { 400: "bad_request", 401: "unauthorized", 403: "forbidden" } as const;

function refuse(res: ServerResponse, status: keyof typeof REFUSAL_ERRORS, message: string): null {
  sendJson(res, status, { error: REFUSAL_ERRORS[status], message });
  return null;
}

async function verifyCapability(
  { req, res, method, pathname, app, deps, secret }: BaseCtx,
  required: { aud: string; bearer?: true } | null,
): Promise<CapabilityClaims | null> {
  const requiredAud = required?.aud ?? null;
  const capToken = capabilityFromHeaders(req) ?? (required?.bearer ? bearerFromHeaders(req) : null);
  if (!capToken) return refuse(res, 401, `${requiredAud} capability token required`);
  const capSecret = deps.capabilitySecret ?? secret;
  const capability = capSecret ? await verifyCapabilityToken(capToken, capSecret) : null;
  if (!capability || foreignTenant(capability.orgId, "capability token"))
    return refuse(res, 401, "invalid or expired capability token");
  if (
    capability.externalSlack &&
    !(
      capability.aud === "credential-broker" &&
      ((method === "POST" && pathname === "/v1/credentials/broker") ||
        pathname.startsWith(CREDENTIAL_HTTP_BROKER_PREFIX))
    )
  )
    return refuse(res, 403, "This operation requires a private conversation.");
  if (deps.identity) {
    await deps.identity.refresh();
    if (deps.identity.classify(capability.actorId).type !== "internal")
      return refuse(res, 401, "principal is no longer active");
  }
  if (capability.deployment !== undefined) {
    const deployment = await app.getDeployment(capability.deployment);
    if (
      !deployment ||
      deployment.id !== capability.deployment ||
      deployment.status !== "running" ||
      deployment.createdBy !== capability.actorId
    )
      return refuse(res, 401, "the published app behind this token is not running");
  }
  if (
    !(capability.externalSlack
      ? await externalSlackCapabilityAllowed(capability, deps)
      : await app.authorizesCapabilityScope({
          actorId: capability.actorId,
          scopeId: capability.scopeId,
          ...(capability.scopeVersion ? { scopeVersion: capability.scopeVersion } : {}),
          ...(capability.botActor ? { botActor: true } : {}),
          ...(capability.liveActor ? { liveActor: true } : {}),
          ...(capability.members ? { members: capability.members } : {}),
        }))
  )
    return refuse(res, 403, "the acting user is not currently authorized for this conversation");
  if (requiredAud && capability.aud !== requiredAud)
    return refuse(res, 403, `this route requires a capability token with audience "${requiredAud}"`);
  return capability;
}

async function gate(
  base: BaseCtx,
  wiring: Wiring,
  raw: string,
  route: Pick<Route, "auth" | "actor" | "admin"> | undefined,
  params: Record<string, string>,
): Promise<GateResult | null> {
  const { req, res, method, pathname, url } = base;
  const routeAuth = route?.auth;
  const { deps, secret, auth, requirePortalIdentity, allowUnsignedSourceAuth } = wiring;
  const isPublicRoute = routeAuth === "public";
  const requiredAuth = typeof routeAuth === "object" ? routeAuth : null;
  const requiredAud = requiredAuth?.aud ?? null;
  let capability: CapabilityClaims | null = null;
  if (!isPublicRoute && (requiredAud || capabilityFromHeaders(req))) {
    capability = await verifyCapability(base, requiredAuth);
    if (!capability) return null;
    if (routeAuth === "either") {
      if (capability.aud !== undefined && capability.aud !== CONTROL_PLANE_AUD)
        return refuse(res, 403, "capability token audience not valid for this route");
      const denied = route?.admin && (await capabilityAdminDenied(route.admin, params, url, capability));
      if (denied) return refuse(res, 403, denied);
    } else if (!requiredAud) {
      return refuse(res, 403, "capability token not valid for this route");
    }
  } else if (
    !isPublicRoute &&
    !(await verifyOrReject(
      req,
      res,
      secret,
      auth,
      canonicalPayload(method, pathname + url.search, raw),
      method !== "GET",
      allowUnsignedSourceAuth,
    ))
  ) {
    return null;
  }
  let body: unknown = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return refuse(res, 400, "invalid JSON body");
    }
  }

  let actor: PortalIdentity | null = null;
  if (!capability) {
    const psecret = deps.portalIdentitySecret ?? secret;
    const rawToken = req.headers[PORTAL_IDENTITY_HEADER];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    actor = token && psecret ? await verifyPortalIdentity(token, psecret, Date.now()) : null;
    if (actor && deps.identity) {
      await deps.identity.refresh(Boolean(actor.authenticatedAs));
      if (
        deps.identity.classify(actor.p).type !== "internal" ||
        (actor.authenticatedAs &&
          (deps.identity.classify(actor.authenticatedAs).type !== "internal" ||
            !samePerson(actor.authenticatedAs, actor.imp ?? actor.p)))
      )
        actor = null;
    }
    if (actor)
      actor = { ...actor, p: canonicalPerson(actor.p), ...(actor.imp ? { imp: canonicalPerson(actor.imp) } : {}) };
    if (!isPublicRoute && requirePortalIdentity) {
      const webTurn =
        method === "POST" &&
        pathname === "/v1/turns" &&
        body !== null &&
        typeof body === "object" &&
        surfaceHas(String((body as { surface?: unknown }).surface), "memberGate");
      const routeActor = route?.actor ?? (WRITE_METHODS.has(method) ? "person" : undefined);
      const needsActor = webTurn || (routeActor !== undefined && routeActor !== "system");
      if (needsActor) {
        if (!psecret || !actor) return refuse(res, 401, "portal identity required");
        const field = !webTurn && routeActor?.includes(".") ? routeActor : undefined;
        let asserted: unknown = null;
        if (webTurn) asserted = (body as { actor?: { externalId?: unknown } }).actor?.externalId ?? null;
        else if (field) asserted = assertedActorField(field, url, body);
        const actorId = actor.p;
        const matchesActor = (value: unknown): boolean => typeof value === "string" && samePerson(value, actorId);
        if ((field && !matchesActor(asserted)) || (!field && asserted !== null && !matchesActor(asserted)))
          return refuse(res, 403, "portal identity does not match the requested actor");
      }
    }
  }
  const field = route?.actor?.includes(".") ? route.actor : undefined;
  const named = field ? assertedActorField(field, url, body) : null;
  const caller = capability?.actorId ?? (typeof named === "string" && named ? named : (actor?.p ?? null));
  return { body, capability, actor, caller };
}

function assertedActorField(field: string, url: URL, body: unknown): unknown {
  const [where, name] = field.split(".", 2) as [string, string];
  if (where === "query") return url.searchParams.get(name);
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : null;
}

function baseCtx(req: IncomingMessage, res: ServerResponse, wiring: Wiring): BaseCtx {
  const url = new URL(req.url ?? "/", "http://localhost");
  return { req, res, ...wiring, url, pathname: url.pathname, method: req.method ?? "GET", params: {} };
}

function typedFailure(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err;
  const as = (status: number, error: string) => new HttpError(status, { error, message: (err as Error).message });
  if (err instanceof MemoryFactsMissing) return as(404, "not_found");
  if (err instanceof MemoryDisclosureDenied) return as(403, "forbidden");
  if (err instanceof KeychainError) return as(err.status, "keychain");
  if (err instanceof BackgroundOwnershipConflict) return as(409, "background_ownership_conflict");
  if (
    err instanceof PayloadTooLargeError ||
    err instanceof ByteSourceTooLargeError ||
    err instanceof InstructionsTooLargeError
  )
    return as(413, "payload_too_large");
  return null;
}

function respondError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  const typed = typedFailure(err);
  if (!typed) {
    reportBackendError(err);
    console.error("[server] 500 %s %s: %s", req.method ?? "?", loggablePath(req.url), errMessage(err));
  }
  if (res.headersSent) return void res.destroy();
  if (typed) sendJson(res, typed.status, typed.body);
  else sendJson(res, 500, { error: "internal_error", message: "internal server error" });
}

type ServerOptions = Omit<ServerDeps, "control">;

const matchRaw = createRouter(rawRoutes);
const matchApi = createRouter(apiRoutes);

function buildServer(app: App, deps: ServerOptions, allowUnsignedSourceAuth: boolean): Server {
  const requirePortalIdentity = Boolean(deps.requireSignedPortalIdentity || deps.production);
  if (deps.signingSecret && !deps.replayDedupe) throw new Error("source auth requires a replay dedupe store");
  const dedupe = deps.replayDedupe;
  const auth =
    deps.signingSecret && dedupe
      ? createSourceAuth({
          get signingSecret() {
            return deps.signingSecret!;
          },
          dedupe,
        })
      : null;
  const wiring: Wiring = {
    app,
    deps: Object.defineProperties(
      { control: createControlService(app, deps.scheduler, deps.admin) } as ServerDeps,
      Object.getOwnPropertyDescriptors(deps),
    ),
    get secret() {
      return deps.signingSecret;
    },
    auth,
    requirePortalIdentity,
    allowUnsignedSourceAuth,
  };
  const server = createHttpServer((req, res) => {
    req.on("error", () => res.destroy());
    res.on("error", () => res.destroy());
    void front(req, res).catch((err: unknown) => respondError(req, res, err));
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 1024;

  async function front(req: IncomingMessage, res: ServerResponse): Promise<void> {
    armBodyDeadline(req, 30_000);
    const base = baseCtx(req, res, wiring);
    if (await proxyDeploymentSubdomain(base)) {
      nameRequest(base.method, "/deployment-proxy/*");
      return;
    }
    if (!canonicalPath(req, base.pathname)) {
      sendJson(res, 404, { error: "not_found", message: `${base.method} ${base.pathname}` });
      return void req.resume();
    }
    const raw = matchRaw(base.method, base.pathname);
    if (raw) {
      if ("path" in raw.route) nameRequest(base.method, raw.route.path);
      const routeAuth = raw.route.auth;
      if (typeof routeAuth === "object") {
        base.capability = await verifyCapability(base, routeAuth);
        if (!base.capability) return void req.resume();
      }
      await run(raw.route, raw.params, base);
      return;
    }
    const matched = matchApi(base.method, base.pathname);
    if (matched && "path" in matched.route) nameRequest(base.method, matched.route.path);
    const routeAuth = matched?.route.auth;
    const acceptsSourceAuth = !matched || routeAuth === "source" || routeAuth === "either";
    if (wiring.secret && !capabilityFromHeaders(req) && routeAuth !== "public" && acceptsSourceAuth) {
      const timestamp = Number(req.headers["x-timestamp"] ?? 0);
      if (
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() - timestamp * 1000) > SOURCE_AUTH_REPLAY_WINDOW_MS ||
        typeof req.headers["x-signature"] !== "string"
      ) {
        sendJson(res, 401, {
          error: "unauthorized",
          message: `missing, invalid, or stale source-auth headers; agent calls must send the capability token as ${CAPABILITY_HEADER}: $AGENT_API_TOKEN`,
        });
        return;
      }
    }
    const gated = await gate(
      base,
      wiring,
      await readRawBody(req, matched?.route.maxBodyBytes),
      matched?.route,
      matched?.params ?? {},
    );
    if (!gated) return;
    if (!matched) return sendJson(res, 404, { error: "not_found", message: `${base.method} ${base.pathname}` });
    const schema = matched.route.body;
    if (schema) {
      const parsed = schema.safeParse(gated.body);
      if (!parsed.success)
        return sendJson(res, 400, { error: "bad_request", message: zodMessage("body", parsed.error) });
      gated.body = parsed.data;
    }
    await run(matched.route, matched.params, { ...base, ...gated });
  }
  return server;
}

export function loggablePath(url: string | undefined): string {
  if (!url) return "?";
  const query = url.indexOf("?");
  return query < 0 ? url : `${url.slice(0, query)}?<query omitted>`;
}

export function createServer(app: App, deps: ServerOptions = {}): Server {
  if (!isStrongSigningSecret(deps.signingSecret)) {
    throw new Error(
      `CORE_SIGNING_SECRET must be at least ${MIN_SIGNING_SECRET_LENGTH} characters; tests that intentionally need unsigned source auth must use createInsecureTestServer`,
    );
  }
  return buildServer(app, deps, false);
}

export function createInsecureTestServer(app: App, deps: ServerOptions = {}): Server {
  if (deps.signingSecret) throw new Error("createInsecureTestServer must not receive a signing secret");
  return buildServer(app, deps, true);
}
