import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
  type Server,
} from "node:http";
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
import { verifyCapabilityToken, CONTROL_PLANE_AUD, type CapabilityClaims } from "../auth/capability-token.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER, type PortalIdentity } from "../auth/portal-identity.ts";
import { isUserScoped, userScopedField, assertedActor, isUnclassifiedWrite } from "./user-scoped-routes.ts";
import { errMessage } from "../util/errors.ts";
import { parseScopeId } from "../types.ts";
import { canonicalPayload, PayloadTooLargeError, readRawBody, sendJson, verifyOrReject } from "./http.ts";
import { dispatch, findRoute, run, type ApiCtx, type BaseCtx, type Route, type RouteAuth } from "./routes/route.ts";
import { apiRoutes, rawRoutes } from "./routes/index.ts";
import { proxyDeploymentSubdomain } from "./routes/deployments.ts";
import { CAPABILITY_HEADER } from "./contract.ts";

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

function capabilityAdminDenied(method: string, pathname: string, url: URL, claims: CapabilityClaims): string | null {
  if (method === "GET" && pathname === "/v1/admin/whoami") return null;
  if (claims.aud !== CONTROL_PLANE_AUD) return "admin routes require the per-turn agent token";
  if (claims.liveActor !== true) {
    return "admin actions through the agent require a turn the admin started themselves — autonomous turns (crons) cannot act as an admin";
  }
  if (pathname.startsWith("/v1/admin/grants")) {
    return "admin grant changes (promote/revoke) are portal-only — the agent cannot manage who governs the org";
  }
  if (pathname.startsWith("/v1/admin/impersonate")) {
    return "impersonating a user is portal-only — the agent cannot act as another person";
  }
  if (
    method === "PUT" &&
    /^\/v1\/admin\/scopes\/[^/]+\/import$/.test(pathname) &&
    parseScopeId(claims.scopeId).kind !== "personal"
  ) {
    return "bulk configuration imports may contain credentials — run them from a DM or the portal";
  }
  if (
    /^\/v1\/admin\/scopes\/[^/]+\/admin-session-reads$/.test(pathname) &&
    parseScopeId(claims.scopeId).kind !== "personal"
  ) {
    return "the admin-session-reads flag governs what may be disclosed here — change it from a DM or the portal";
  }
  if (method === "GET" && isAdminContentRead(pathname) && parseScopeId(claims.scopeId).kind !== "personal") {
    let target = "";
    if (pathname.startsWith("/v1/admin/scopes/"))
      target = safeDecode(pathname.slice("/v1/admin/scopes/".length).split("/")[0] ?? "");
    else if (pathname === "/v1/admin/memory") target = url.searchParams.get("scope") ?? "";
    if (parseScopeId(target).kind !== "org") {
      return "this admin read returns private content — ask the agent in a DM";
    }
  }
  return null;
}

function isAdminContentRead(pathname: string): boolean {
  if (pathname === "/v1/admin/memory") return true;
  if (pathname === "/v1/admin/keychain") return true;
  if (pathname === "/v1/admin/volumes") return true;
  if (pathname.startsWith("/v1/admin/scopes/")) return true;
  if (pathname.startsWith("/v1/admin/sessions")) return true;
  if (pathname.startsWith("/v1/admin/files")) return true;
  if (
    pathname === "/v1/admin/runs" ||
    pathname === "/v1/admin/audit" ||
    pathname === "/v1/admin/errors" ||
    pathname === "/v1/admin/egress"
  )
    return true;
  if (pathname === "/v1/admin/crons" || pathname === "/v1/admin/deployments" || pathname === "/v1/admin/skills")
    return true;
  if (pathname === "/v1/admin/deliveries/shadow") return true;
  if (pathname.startsWith("/v1/admin/slack-mirror")) return true;
  if (pathname.startsWith("/v1/admin/ambient-judgments")) return true;
  if (pathname.startsWith("/v1/admin/ack-emoji-picks")) return true;
  if (pathname.startsWith("/v1/admin/skills/")) return true;
  if (pathname.startsWith("/v1/admin/users/")) return true;
  return false;
}

function strictPostAllowed(pathname: string, body: unknown): boolean {
  if (
    pathname === "/v1/surface-context" ||
    pathname === "/v1/projects" ||
    pathname === "/v1/conversations" ||
    pathname === "/v1/memory/search" ||
    pathname === "/v1/memory/restore" ||
    pathname.startsWith("/v1/run-signals/") ||
    /^\/v1\/conversations\/[^/]+\/fork$/.test(pathname)
  )
    return true;
  if (/^\/v1\/projects\/[^/]+(?:\/members(?:\/[^/]+)?)?$/.test(pathname)) return true;
  if (/^\/v1\/skills\/[^/]+\/restore$/.test(pathname)) return true;
  return (
    /^\/v1\/triggers\/[^/]+\/consent$/.test(pathname) && (body as { decision?: unknown } | null)?.decision === "decline"
  );
}

function capabilityFromHeaders(req: IncomingMessage): string | null {
  const h = req.headers[CAPABILITY_HEADER];
  return typeof h === "string" && h ? h : null;
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

async function gate(
  req: IncomingMessage,
  res: ServerResponse,
  { app, deps, secret, auth, requirePortalIdentity, allowUnsignedSourceAuth }: Wiring,
  method: string,
  pathname: string,
  url: URL,
  raw: string,
  routeAuth: RouteAuth | undefined,
): Promise<GateResult | null> {
  const isPublicRoute = routeAuth === "public";
  const requiredAud = typeof routeAuth === "object" ? routeAuth.aud : null;
  let capability: CapabilityClaims | null = null;
  const capToken = capabilityFromHeaders(req);
  if (isPublicRoute) {
    void isPublicRoute;
  } else if (capToken) {
    const capSecret = deps.capabilitySecret ?? secret;
    capability = capSecret ? await verifyCapabilityToken(capToken, capSecret) : null;
    if (!capability) {
      sendJson(res, 401, { error: "unauthorized", message: "invalid or expired capability token" });
      return null;
    }
    if (deps.identity) {
      await deps.identity.refresh();
      if (deps.identity.classify(capability.actorId).type !== "internal") {
        sendJson(res, 401, { error: "unauthorized", message: "principal is no longer active" });
        return null;
      }
    }
    if (
      !(await app.authorizesCapabilityScope({
        actorId: capability.actorId,
        scopeId: capability.scopeId,
        ...(capability.scopeVersion ? { scopeVersion: capability.scopeVersion } : {}),
      }))
    ) {
      sendJson(res, 403, { error: "forbidden", message: "capability scope membership has been revoked" });
      return null;
    }
    if (requiredAud) {
      if (capability.aud !== requiredAud) {
        sendJson(res, 403, {
          error: "forbidden",
          message: `this route requires a capability token with audience "${requiredAud}"`,
        });
        return null;
      }
    } else if (routeAuth === "either") {
      if (capability.aud !== undefined && capability.aud !== CONTROL_PLANE_AUD) {
        sendJson(res, 403, { error: "forbidden", message: "capability token audience not valid for this route" });
        return null;
      }
      if (pathname.startsWith("/v1/admin/")) {
        const denied = capabilityAdminDenied(method, pathname, url, capability);
        if (denied) {
          sendJson(res, 403, { error: "forbidden", message: denied });
          return null;
        }
      }
    } else {
      sendJson(res, 403, { error: "forbidden", message: "capability token not valid for this route" });
      return null;
    }
  } else if (requiredAud) {
    sendJson(res, 401, { error: "unauthorized", message: `${requiredAud} capability token required` });
    return null;
  } else if (
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
    !strictPostAllowed(pathname, body) &&
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
    actor = token && psecret ? await verifyPortalIdentity(token, psecret, Date.now()) : null;
    if (actor && deps.identity) {
      await deps.identity.refresh();
      if (deps.identity.classify(actor.p).type !== "internal") actor = null;
    }
    if (!isPublicRoute && requirePortalIdentity) {
      const webTurn =
        method === "POST" &&
        pathname === "/v1/turns" &&
        body !== null &&
        typeof body === "object" &&
        (body as { surface?: unknown }).surface === "web";
      const needsActor =
        isUserScoped(method, pathname) ||
        webTurn ||
        pathname.startsWith("/v1/admin/") ||
        isUnclassifiedWrite(method, pathname);
      if (needsActor) {
        if (!psecret || !actor) {
          sendJson(res, 401, { error: "unauthorized", message: "portal identity required" });
          return null;
        }
        const field = webTurn ? undefined : userScopedField(method, pathname);
        let asserted: unknown = null;
        if (webTurn) asserted = (body as { actor?: { externalId?: unknown } }).actor?.externalId ?? null;
        else if (field) asserted = assertedActor(field, url, body, req);
        if ((field && asserted !== actor.p) || (!field && asserted !== null && asserted !== actor.p)) {
          sendJson(res, 403, { error: "forbidden", message: "portal identity does not match the requested actor" });
          return null;
        }
      }
    }
  }
  return { body, capability, actor };
}

function baseCtx(req: IncomingMessage, res: ServerResponse, wiring: Wiring): BaseCtx {
  const url = new URL(req.url ?? "/", "http://localhost");
  return { req, res, ...wiring, url, pathname: url.pathname, method: req.method ?? "GET", params: {} };
}

function respondError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof PayloadTooLargeError) {
    if (!res.headersSent) sendJson(res, 413, { error: "payload_too_large", message: errMessage(err) });
    else res.destroy();
    return;
  }
  console.error("[server] 500 %s %s: %s", req.method ?? "?", req.url ?? "?", errMessage(err));
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
      const g = await gate(req, res, wiring, base.method, base.pathname, base.url, raw, found?.route.auth);
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
    console.error(`[server] 500 ${request.raw.method ?? "?"} ${request.raw.url ?? "?"}:`, errMessage(err));
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
      request.routeOptions.config.route?.auth,
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

function buildServer(app: App, deps: ServerOptions, allowUnsignedSourceAuth: boolean): Server {
  const requirePortalIdentity = Boolean(deps.requireSignedPortalIdentity || deps.production);
  const auth = deps.signingSecret
    ? createSourceAuth({
        signingSecret: deps.signingSecret,
        ...(deps.replayDedupe ? { dedupe: deps.replayDedupe } : {}),
      })
    : null;
  const wiring: Wiring = {
    app,
    deps: { ...deps, control: createControlService(app, deps.scheduler) },
    secret: deps.signingSecret,
    auth,
    requirePortalIdentity,
    allowUnsignedSourceAuth,
  };
  const server = createHttpServer((req, res) => {
    req.on("error", () => res.destroy());
    res.on("error", () => res.destroy());
    void front(req, res).catch((err: unknown) => respondError(req, res, err));
  });
  const { fastify, routing } = buildFastify(wiring, server);
  const ready = Promise.resolve(fastify.ready());
  ready.catch((err: unknown) => console.error("[server] fastify initialization failed:", errMessage(err)));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 1024;

  async function front(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const base = baseCtx(req, res, wiring);
    if (await proxyDeploymentSubdomain(base)) return;
    if (await dispatch(rawRoutes, base)) return;
    const matched = findRoute(apiRoutes, base.method, base.pathname);
    const routeAuth = matched?.route.auth;
    const acceptsSourceAuth = !matched || routeAuth === "source" || routeAuth === "either";
    if (wiring.secret && !capabilityFromHeaders(req) && routeAuth !== "public" && acceptsSourceAuth) {
      const timestamp = Number(req.headers["x-timestamp"] ?? 0);
      if (
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() - timestamp * 1000) > SOURCE_AUTH_REPLAY_WINDOW_MS ||
        typeof req.headers["x-signature"] !== "string"
      ) {
        sendJson(res, 401, { error: "unauthorized", message: "missing, invalid, or stale source-auth headers" });
        return;
      }
    }
    rawBodies.set(req, await readRawBody(req));
    await ready;
    routing(req, res);
  }
  return server;
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
