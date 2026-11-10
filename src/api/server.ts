import { externalSlackCapabilityAllowed } from "./external-slack-capability.ts";
import { MemoryDisclosureDenied } from "../memory/disclosure.ts";
import { MemoryFactsMissing } from "../memory/facts.ts";
import { nameRequest, reportBackendError, withRequestContext } from "../../plugins/chassis/src/error-reporting.ts";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
  type Server,
} from "node:http";
import type { Duplex } from "node:stream";
import { failUpgrade, isWebSocketUpgrade, responseOnSocket } from "../../plugins/chassis/src/websocket-relay.ts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods } from "fastify";
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
import { CONTROL_PLANE_AUD, type CapabilityClaims } from "../auth/capability-token.ts";
import { bootTenant } from "../tenants/boot.ts";
import { capabilityToken, identityTenant, requestCapability, withRequestTenant } from "./request-tenant.ts";
import type { Tenant } from "../tenants/context.ts";
import { inboundKey, withInboundTenant } from "./inbound-tenant.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER, type PortalIdentity } from "../auth/portal-identity.ts";
import { errMessage } from "../util/errors.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { canonicalPayload } from "../../plugins/chassis/src/source-auth-sign.ts";
import { KEEP_ALIVE_TIMEOUT_MS, logUnansweredCloses } from "../../plugins/chassis/src/http.ts";
import { armBodyDeadline, PayloadTooLargeError, readRawBody, sendJson, verifyOrReject } from "./http.ts";
import {
  findRoute,
  run,
  usesBrowserSession,
  type AdminAccess,
  type ApiCtx,
  type BaseCtx,
  type Route,
} from "./routes/route.ts";
import { apiRoutes, rawRoutes } from "./routes/index.ts";
import { proxyDeploymentSubdomain } from "./routes/deployments.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { livePersonCapability } from "./artifact-share.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import {
  apiAlias,
  appHostRequest,
  browserIdentity,
  browserSessionTenant,
  withBrowserActor,
} from "./browser-session.ts";

async function capabilityAdminDenied(
  access: AdminAccess,
  params: Record<string, string>,
  url: URL,
  claims: CapabilityClaims,
  config: ServerDeps["config"],
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
    if (
      parseScopeId(target).kind !== "org" &&
      (!livePersonCapability(claims) ||
        (await config?.resolveSharingPostureDurable(scopeId("personal", claims.actorId), claims.scopeId)) !== "open")
    ) {
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

interface GateResult {
  body: unknown;
  capability: CapabilityClaims | null;
  actor: PortalIdentity | null;
}

interface Wiring {
  app: App;
  deps: ServerDeps;
  secret: string | undefined;
  auth: SourceAuth | null;
  requirePortalIdentity: boolean;
  allowUnsignedSourceAuth: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    route?: Route<ApiCtx>;
  }
  interface FastifyRequest {
    gate?: GateResult;
  }
}

const rawBodies = new WeakMap<IncomingMessage, string>();

async function verifyCapability(
  req: IncomingMessage,
  res: ServerResponse,
  { app, deps, secret }: Wiring,
  method: string,
  pathname: string,
  required: { aud: string; bearer?: true } | null,
): Promise<CapabilityClaims | null> {
  const requiredAud = required?.aud ?? null;
  const capToken = capabilityToken(req, required?.bearer === true);
  if (!capToken) {
    sendJson(res, 401, { error: "unauthorized", message: `${requiredAud} capability token required` });
    return null;
  }
  const capability = await requestCapability(req, capToken, deps.capabilitySecret ?? secret);
  if (!capability) {
    sendJson(res, 401, { error: "unauthorized", message: "invalid or expired capability token" });
    return null;
  }
  if (
    capability.externalSlack &&
    !(
      capability.aud === "credential-broker" &&
      ((method === "POST" && pathname === "/v1/credentials/broker") ||
        ((method === "GET" || method === "POST") && pathname.startsWith("/v1/credentials/git/")))
    )
  ) {
    sendJson(res, 403, { error: "forbidden", message: "This operation requires a private conversation." });
    return null;
  }
  if (deps.identity) {
    await deps.identity.refresh();
    if (deps.identity.classify(capability.actorId).type !== "internal") {
      sendJson(res, 401, { error: "unauthorized", message: "principal is no longer active" });
      return null;
    }
  }
  if (capability.deployment !== undefined) {
    const deployment = await app.getDeployment(capability.deployment);
    if (
      !deployment ||
      deployment.id !== capability.deployment ||
      deployment.status !== "running" ||
      deployment.createdBy !== capability.actorId
    ) {
      sendJson(res, 401, { error: "unauthorized", message: "the published app behind this token is not running" });
      return null;
    }
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
  ) {
    sendJson(res, 403, {
      error: "forbidden",
      message: "the acting user is not currently authorized for this conversation",
    });
    return null;
  }
  if (requiredAud && capability.aud !== requiredAud) {
    sendJson(res, 403, {
      error: "forbidden",
      message: `this route requires a capability token with audience "${requiredAud}"`,
    });
    return null;
  }
  return capability;
}

async function gate(
  req: IncomingMessage,
  res: ServerResponse,
  wiring: Wiring,
  method: string,
  pathname: string,
  url: URL,
  raw: string,
  route: Pick<Route, "auth" | "actor" | "admin" | "allowedInStrict" | "browser"> | undefined,
  params: Record<string, string>,
  tenant: Tenant | undefined,
): Promise<GateResult | null> {
  const routeAuth = route?.auth;
  const { deps, secret, auth, requirePortalIdentity, allowUnsignedSourceAuth } = wiring;
  const isPublicRoute = routeAuth === "public";
  const browser = !isPublicRoute && usesBrowserSession(req, route);
  const requiredAuth = typeof routeAuth === "object" ? routeAuth : null;
  const requiredAud = requiredAuth?.aud ?? null;
  let capability: CapabilityClaims | null = null;
  const capToken = capabilityToken(req, false);
  if (isPublicRoute) {
    void isPublicRoute;
  } else if (requiredAud || capToken) {
    capability = await verifyCapability(req, res, wiring, method, pathname, requiredAuth);
    if (!capability) return null;
    if (routeAuth === "either") {
      if (capability.aud !== undefined && capability.aud !== CONTROL_PLANE_AUD) {
        sendJson(res, 403, { error: "forbidden", message: "capability token audience not valid for this route" });
        return null;
      }
      if (route?.admin) {
        const denied = await capabilityAdminDenied(route.admin, params, url, capability, deps.config);
        if (denied) {
          sendJson(res, 403, { error: "forbidden", message: denied });
          return null;
        }
      }
    } else if (!requiredAud) {
      sendJson(res, 403, { error: "forbidden", message: "capability token not valid for this route" });
      return null;
    }
  } else if (
    !browser &&
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
      sendJson(res, 400, { error: "bad_request", message: "invalid JSON body" });
      return null;
    }
  }
  if (
    capability &&
    !requiredAud &&
    method !== "GET" &&
    !route?.allowedInStrict &&
    deps.config &&
    (await deps.config.getSecurityPostureDurable(capability.scopeId)) === "strict"
  ) {
    sendJson(res, 403, { error: "forbidden", message: "Strict posture blocks direct control-plane mutations" });
    return null;
  }

  let actor: PortalIdentity | null = null;
  if (!capability) {
    const psecret = deps.portalIdentitySecret ?? secret;
    const rawToken = req.headers[PORTAL_IDENTITY_HEADER];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (browser) {
      const signedIn = await browserIdentity(req, method, deps, route?.browser === "embed", tenant);
      if ("status" in signedIn) {
        sendJson(res, signedIn.status, { error: signedIn.error, message: signedIn.message });
        return null;
      }
      if ((route?.browser === "self" || route?.admin) && signedIn.imp) {
        sendJson(res, 403, { error: "forbidden", message: "Unavailable while impersonating." });
        return null;
      }
      actor = signedIn;
    } else actor = token && psecret ? await verifyPortalIdentity(token, psecret, Date.now()) : null;
    if (actor && deps.identity) {
      const identity = deps.identity;
      const verified = ({ p, imp, authenticatedAs }: PortalIdentity) =>
        identity.classify(p).type === "internal" &&
        (!authenticatedAs ||
          (identity.classify(authenticatedAs).type === "internal" && samePerson(authenticatedAs, imp ?? p)));
      await identity.refresh();
      if (!verified(actor) && actor.authenticatedAs) await identity.refresh(true);
      if (!verified(actor)) actor = null;
    }
    if (actor)
      actor = { ...actor, p: canonicalPerson(actor.p), ...(actor.imp ? { imp: canonicalPerson(actor.imp) } : {}) };
    if (!isPublicRoute && (requirePortalIdentity || browser)) {
      const webTurn =
        method === "POST" &&
        pathname === "/v1/turns" &&
        body !== null &&
        typeof body === "object" &&
        (body as { surface?: unknown }).surface === "web";
      const routeActor = route?.actor ?? (WRITE_METHODS.has(method) ? "person" : undefined);
      const needsActor = browser || webTurn || (routeActor !== undefined && routeActor !== "system");
      if (needsActor) {
        if (!actor) {
          const message = browser ? "principal is no longer active" : "portal identity required";
          sendJson(res, 401, { error: "unauthorized", message });
          return null;
        }
        if (browser) body = withBrowserActor(route?.actor, req, url, body, actor.p);
        const field = !webTurn && routeActor?.includes(".") ? routeActor : undefined;
        const fields = [field, ...(browser && !route?.admin ? ["query.principalId", "body.principalId"] : [])];
        const claimed = [
          ...fields.flatMap((f) => (f ? assertedActorValues(f, url, body) : [])),
          ...(webTurn
            ? [(body as { actor?: { externalId?: unknown } }).actor?.externalId ?? null].filter((v) => v !== null)
            : []),
        ];
        const actorId = actor.p;
        const matchesActor = (value: unknown): boolean => typeof value === "string" && samePerson(value, actorId);
        if ((field && claimed.length === 0) || !claimed.every(matchesActor)) {
          sendJson(res, 403, { error: "forbidden", message: "portal identity does not match the requested actor" });
          return null;
        }
      }
    }
  }
  return { body, capability, actor };
}

function assertedActorValues(field: string, url: URL, body: unknown): unknown[] {
  const [where, name] = field.split(".", 2) as [string, string];
  if (where === "query") return url.searchParams.getAll(name);
  return body && typeof body === "object" && Object.hasOwn(body, name) ? [(body as Record<string, unknown>)[name]] : [];
}

const requestTenants = new WeakMap<IncomingMessage, Tenant>();

function baseCtx(req: IncomingMessage, res: ServerResponse, wiring: Wiring): BaseCtx {
  const url = new URL(req.url ?? "/", "http://localhost");
  const tenant = requestTenants.get(req);
  return {
    req,
    res,
    ...wiring,
    url,
    pathname: url.pathname,
    method: req.method ?? "GET",
    params: {},
    ...(tenant ? { tenant } : {}),
  };
}

function respondError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof MemoryDisclosureDenied || err instanceof MemoryFactsMissing) {
    const status = err instanceof MemoryFactsMissing ? 404 : 403;
    if (!res.headersSent)
      sendJson(res, status, { error: status === 404 ? "not_found" : "forbidden", message: err.message });
    else res.destroy();
    return;
  }
  if (err instanceof PayloadTooLargeError) {
    if (!res.headersSent) sendJson(res, 413, { error: "payload_too_large", message: errMessage(err) });
    else res.destroy();
    return;
  }
  reportBackendError(err);
  console.error("[server] 500 %s %s: %s", req.method ?? "?", loggablePath(req.url), errMessage(err));
  if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: "internal server error" });
  else res.destroy();
}

function paramsSchema(path: string): object {
  const names = path
    .split("/")
    .filter((seg) => seg.startsWith(":"))
    .map((seg) => seg.slice(1));
  return {
    type: "object",
    properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])),
    required: names,
  };
}

function buildFastify(wiring: Wiring, server: Server): { fastify: FastifyInstance; routing: RequestListener } {
  const matchRoutes = apiRoutes.filter(
    (route): route is Route<ApiCtx> & { match: (m: string, p: string) => boolean } => !("path" in route),
  );

  const fallback = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    const req = request.raw;
    const res = reply.raw;
    try {
      const base = baseCtx(req, res, wiring);
      const raw = rawBodies.get(req) ?? "";
      const found = findRoute(matchRoutes, base.method, base.pathname);
      const g = await gate(
        req,
        res,
        wiring,
        base.method,
        base.pathname,
        base.url,
        raw,
        found?.route,
        found?.params ?? {},
        base.tenant,
      );
      if (!g) return;
      if (found) {
        const ctx: ApiCtx = {
          ...base,
          body: g.body,
          capability: g.capability,
          actor: g.actor,
        };
        await run(found.route, found.params, ctx);
        return;
      }
      sendJson(res, 404, { error: "not_found", message: `${base.method} ${base.pathname}` });
    } catch (err) {
      respondError(req, res, err);
    }
  };

  let routing!: RequestListener;
  const fastify = Fastify({
    serverFactory: (handler) => {
      routing = handler as RequestListener;
      return server;
    },
    logger: false,
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 100_000 },
    frameworkErrors: (_err, request, reply) => {
      void fallback(request, reply);
    },
  });

  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("*", (request, _payload, done) => {
    done(null, rawBodies.get(request.raw) ?? "");
  });
  fastify.decorateRequest("gate", undefined);

  fastify.setErrorHandler((err, request, reply) => {
    reportBackendError(err);
    console.error("%s", `[server] 500 ${request.raw.method ?? "?"} ${loggablePath(request.raw.url)}:`, errMessage(err));
    return reply.code(500).send({ error: "internal_error", message: "internal server error" });
  });

  const gateHook = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const url = new URL(request.raw.url ?? "/", "http://localhost");
    const raw = rawBodies.get(request.raw) ?? "";
    const result = await gate(
      request.raw,
      reply.raw,
      wiring,
      request.raw.method ?? "GET",
      url.pathname,
      url,
      raw,
      request.routeOptions.config.route,
      request.params as Record<string, string>,
      requestTenants.get(request.raw),
    );
    if (!result) {
      reply.hijack();
      return;
    }
    request.gate = result;
  };

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    const route = request.routeOptions.config.route!;
    const g = request.gate!;
    const ctx: ApiCtx = {
      ...baseCtx(request.raw, reply.raw, wiring),
      body: g.body,
      capability: g.capability,
      actor: g.actor,
    };
    try {
      await run(route, request.params as Record<string, string>, ctx);
    } catch (err) {
      respondError(request.raw, reply.raw, err);
    }
  };

  for (const route of apiRoutes) {
    if (!("path" in route)) continue;
    fastify.route({
      method: route.method as HTTPMethods,
      url: route.path,
      config: { route },
      schema: { params: paramsSchema(route.path) },
      preValidation: gateHook,
      handler,
    });
  }

  fastify.setNotFoundHandler(fallback);

  return { fastify, routing };
}

type ServerOptions = Omit<ServerDeps, "control">;

type Matched<C extends BaseCtx> = { route: Route<C>; params: Record<string, string> } | null;

function buildServer(app: App, deps: ServerOptions, allowUnsignedSourceAuth: boolean): Server {
  const requirePortalIdentity = Boolean(deps.requireSignedPortalIdentity || deps.production);
  if (deps.signingSecret && !deps.replayDedupe) throw new Error("source auth requires a replay dedupe store");
  const auth =
    deps.signingSecret && deps.replayDedupe
      ? createSourceAuth({ signingSecret: deps.signingSecret, dedupe: deps.replayDedupe })
      : null;
  const wiring: Wiring = {
    app,
    deps: { ...deps, control: createControlService(app, deps.scheduler, deps.admin) },
    secret: deps.signingSecret,
    auth,
    requirePortalIdentity,
    allowUnsignedSourceAuth,
  };
  const server = createHttpServer((req, res) => {
    req.on("error", () => res.destroy());
    res.on("error", () => res.destroy());
    void withRequestContext("core", req, res, () => front(req, res)).catch((err: unknown) =>
      respondError(req, res, err),
    );
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void upgradeFront(req, socket, head).catch((error: unknown) => failUpgrade(socket, "deployment-websocket", error));
  });
  const { fastify, routing } = buildFastify(wiring, server);
  const ready = Promise.resolve(fastify.ready());
  ready.catch((err: unknown) => console.error("[server] fastify initialization failed:", errMessage(err)));
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = 1024;
  logUnansweredCloses(server, "core");

  const capabilitySecret = deps.capabilitySecret ?? deps.signingSecret;
  async function upgradeFront(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const res = isWebSocketUpgrade(req) ? responseOnSocket(req, socket) : null;
    if (!res) return void socket.destroy();
    const base: BaseCtx = { ...baseCtx(req, res, wiring), upgrade: { socket, head } };
    await withRequestContext("core", req, res, () =>
      inRequestTenant(req, res, base, null, async () => {
        if (await proxyDeploymentSubdomain(base)) return nameRequest(base.method, "/deployment-proxy/websocket");
        sendJson(res, 404, { error: "not_found" });
      }),
    );
  }

  async function front(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let base = baseCtx(req, res, wiring);
    const alias = appHostRequest(req, deps) ? null : apiAlias(base.method, base.pathname);
    if (alias && canonicalPath(req, base.pathname)) {
      req.url = `${alias}${base.url.search}`;
      base = baseCtx(req, res, wiring);
    }
    const raw = findRoute(rawRoutes, base.method, base.pathname);
    const matched = raw ? null : findRoute(apiRoutes, base.method, base.pathname);
    await inRequestTenant(req, res, base, raw ?? matched, () => serve(req, res, base, raw, matched));
  }

  async function inRequestTenant(
    req: IncomingMessage,
    res: ServerResponse,
    base: BaseCtx,
    found: Matched<BaseCtx> | Matched<ApiCtx>,
    then: () => Promise<void>,
  ): Promise<void> {
    const route = found?.route;
    const next = (tenant: Tenant | undefined): Promise<void> => {
      if (tenant) {
        requestTenants.set(req, tenant);
        base.tenant = tenant;
      }
      return then();
    };
    const inbound = inboundKey(req, deps, found, base.url);
    if (inbound)
      return withInboundTenant(
        app,
        inbound,
        next,
        async () =>
          (await identityTenant(req, deps.portalIdentitySecret ?? deps.signingSecret)) ??
          (usesBrowserSession(req, route) ? (browserSessionTenant(req, deps) ?? bootTenant()) : undefined),
      );
    await withRequestTenant(
      req,
      res,
      route,
      capabilitySecret,
      bootTenant(),
      next,
      deps.portalIdentitySecret ?? deps.signingSecret,
      () => (usesBrowserSession(req, route) ? browserSessionTenant(req, deps) : undefined),
    );
  }

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    base: BaseCtx,
    raw: Matched<BaseCtx>,
    matched: Matched<ApiCtx>,
  ): Promise<void> {
    armBodyDeadline(req, deps.requestBodyDeadlineMs ?? 30_000);
    if (await proxyDeploymentSubdomain(base)) {
      nameRequest(base.method, "/deployment-proxy/*");
      return;
    }
    if (!canonicalPath(req, base.pathname)) {
      sendJson(res, 404, { error: "not_found", message: `${base.method} ${base.pathname}` });
      return void req.resume();
    }
    if (raw) {
      const routeAuth = raw.route.auth;
      if (typeof routeAuth === "object") {
        base.capability = await verifyCapability(req, res, wiring, base.method, base.pathname, routeAuth);
        if (!base.capability) return void req.resume();
      }
      await run(raw.route, raw.params, base);
      return;
    }
    if (matched && "path" in matched.route) nameRequest(base.method, matched.route.path);
    const routeAuth = matched?.route.auth;
    const acceptsSourceAuth = !matched || routeAuth === "source" || routeAuth === "either";
    if (
      wiring.secret &&
      !capabilityToken(req, false) &&
      routeAuth !== "public" &&
      acceptsSourceAuth &&
      !usesBrowserSession(req, matched?.route)
    ) {
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
    if (!matched?.route.streamBody || !usesBrowserSession(req, matched.route))
      rawBodies.set(req, await readRawBody(req, matched?.route.maxBodyBytes));
    await ready;
    routing(req, res);
  }
  return server;
}

export function loggablePath(url: string | undefined): string {
  if (!url) return "?";
  const query = url.indexOf("?");
  return query < 0 ? url : `${url.slice(0, query)}?<query omitted>`;
}

export function createServer(app: App, deps: ServerOptions = {}): Server {
  if (!deps.signingSecret && deps.allowUnauthenticatedCore) {
    console.warn(
      "[server] ALLOW_UNAUTHENTICATED_CORE=1 — HTTP ingress is UNAUTHENTICATED (intentionally isolated deployments only).",
    );
    return buildServer(app, deps, true);
  }
  if (!isStrongSigningSecret(deps.signingSecret)) {
    throw new Error(
      `CORE_SIGNING_SECRET must be at least ${MIN_SIGNING_SECRET_LENGTH} characters; tests that intentionally need unsigned source auth must use createInsecureTestServer`,
    );
  }
  if (deps.requireSignedPortalIdentity || deps.production) {
    const shared = (name: string, value: string | undefined): string | null => {
      if (!value) return `${name} is not set (it would fall back to CORE_SIGNING_SECRET)`;
      return value === deps.signingSecret ? `${name} must differ from CORE_SIGNING_SECRET` : null;
    };
    const problem =
      shared("CAPABILITY_SECRET", deps.capabilitySecret) ??
      shared("PORTAL_IDENTITY_SECRET", deps.portalIdentitySecret) ??
      (deps.capabilitySecret === deps.portalIdentitySecret
        ? "PORTAL_IDENTITY_SECRET must differ from CAPABILITY_SECRET"
        : null);
    if (problem)
      throw new Error(
        `signed portal identity is required but ${problem}. Provision distinct secrets or enforcement is bypassable.`,
      );
  }
  return buildServer(app, deps, false);
}

export function createInsecureTestServer(app: App, deps: ServerOptions = {}): Server {
  if (deps.signingSecret) throw new Error("createInsecureTestServer must not receive a signing secret");
  return buildServer(app, deps, true);
}
