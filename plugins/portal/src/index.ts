import { reportBackendError, reportFailure } from "../../chassis/src/error-reporting.ts";
import "./instrument.ts";
import { createServer, METHODS, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { serveForHost } from "../../chassis/src/tenant-hosts.ts";
import { answerPreflight, prepareCors } from "./cors.ts";
import {
  seal,
  openImpersonation,
  setCookie,
  clearCookie,
  readCookie,
  type SessionClaims,
  type ImpersonationClaims,
} from "./session.ts";
import {
  proxyToSurface,
  proxyToDeployment,
  proxyToUpstream,
  proxyToAppHost,
  FORWARD_AGENT_API_HEADERS,
  FORWARD_SANDBOX_MODEL_HEADERS,
  FORWARD_DEPLOYMENT_LAYER_HEADERS,
  FORWARD_OAUTH_HEADERS,
  FORWARD_BROKER_HEADERS,
  FORWARD_WEBHOOK_HEADERS,
} from "./proxy.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { isUiChannel, UI_CHANNEL_COOKIE } from "../../chassis/src/ui-release.ts";
import { CARD_SCENE_PATH, LOCK_ICON } from "../../chassis/src/card-page.ts";
import { json, serveFavicon, readBody, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { CORE_API_URL as CORE, coreOrgId, coreSigningSecret, portalIdentitySecret } from "../../chassis/src/env.ts";

import {
  PORT,
  SESSION_SECRET,
  SESSION_TTL_S,
  SECURE_COOKIES,
  LOCAL_AUTH_BYPASS,
  LOCAL_AUTH_PRINCIPAL,
  PLAYGROUND,
  DEPLOYMENTS_ENABLED,
  PLAYGROUND_MINTS_PER_IP,
  PLAYGROUND_MINT_WINDOW_S,
  WEB_UI_UPSTREAM,
  AUTH_BROKER_PREFIX,
  brokerRouteFor,
  XFF_TRUSTED_HOPS,
  clientIpOf,
  IMPERSONATE_TTL_S,
  isLoopbackAddress,
  bootChecks,
  site,
} from "./config.ts";
import {
  modelProviderConfigured,
  refreshSurfaceConfig,
  coreCall,
  portalIdentityHeaders,
  isAdmin,
  canonicalPrincipal,
  coreImpersonate,
} from "./core-calls.ts";
import {
  identityUnavailable,
  serveCardScene,
  sendHtml,
  redirect,
  wantsHtml,
  notConfiguredHtml,
  connectPage,
  connectErrorHtml,
  connectWrongRecipientHtml,
  playgroundBusyHtml,
  playgroundRestrictedHtml,
} from "./pages.ts";
import {
  LOCAL_LOGOUT_COOKIE,
  sameOriginRequest,
  currentSession,
  loginProviderCookie,
  FRAME_SESSION_COOKIE,
  setSession,
  mintPlaygroundSession,
  renewSessionCookie,
} from "./sessions.ts";
import { desktopLogin, inviteLogin, adminLogin, trustedAuth, authLogin, authCallback } from "./login-routes.ts";

export { derivedCookieDomain, hostIsWithinDomain, isPrivateNetworkUrl } from "./config.ts";
export { mintBucketOf } from "./sessions.ts";
export { brokerRouteFor, clientIpOf, isLoopbackAddress, bootChecks };

async function handleConsentRedeem(
  res: ServerResponse,
  o: { corePath: string; session: SessionClaims },
): Promise<void> {
  let data: { status?: string; authorizeUrl?: string; provider?: string; clickerConnected?: boolean };
  try {
    data = (await coreCall<typeof data>("GET", o.corePath, { headers: portalIdentityHeaders(o.session.sub) })).body;
  } catch (error) {
    reportFailure("portal: consent redeem", error);
    return sendHtml(
      res,
      502,
      connectErrorHtml("We couldn't reach the connection service. Please try the link again in a moment."),
    );
  }
  switch (data.status) {
    case "authorize":
      if (!data.authorizeUrl)
        return sendHtml(res, 502, connectErrorHtml("The connection service returned an unexpected response."));
      return redirect(res, 302, data.authorizeUrl);
    case "wrong_recipient":
      return sendHtml(
        res,
        200,
        connectWrongRecipientHtml({ provider: data.provider ?? "", alreadyConnected: !!data.clickerConnected }),
      );
    case "expired":
      return sendHtml(res, 200, connectErrorHtml("This connect link has expired. Ask the agent for a fresh one."));
    default:
      return sendHtml(
        res,
        200,
        connectErrorHtml("This connect link is invalid or was already used. Ask the agent for a fresh one."),
      );
  }
}

async function handleSecretDrop(
  req: IncomingMessage,
  res: ServerResponse,
  o: { method: string; corePath: string; session: SessionClaims },
): Promise<void> {
  const isPost = o.method === "POST";
  let rawBody = "";
  if (isPost) {
    try {
      rawBody = await readBody(req, 64 * 1024);
    } catch (error) {
      if (!(error instanceof PayloadTooLargeError)) throw error;
      return json(res, 413, { error: "too_large", message: "that value is too large" });
    }
  }
  const path = withSourceAuthNonce(o.corePath, coreSigningSecret());
  const headers = {
    ...signedHeaders(coreSigningSecret(), isPost ? "POST" : "GET", path, rawBody),
    "x-drop-owner": o.session.sub,
    "x-drop-owner-org": o.session.org,
  };
  let r: Response;
  try {
    r = await fetch(`${CORE}${path}`, {
      method: isPost ? "POST" : "GET",
      headers,
      ...(isPost ? { body: rawBody } : {}),
    });
  } catch (error) {
    reportFailure("portal: secret drop relay", error);
    if (isPost)
      return json(res, 502, {
        error: "unreachable",
        message: "couldn't reach the credential service, try again in a moment",
      });
    return sendHtml(res, 502, connectPage({ title: "Service unavailable", body: "Try the link again in a moment." }));
  }
  const bodyText = await r.text();
  const ct = r.headers.get("content-type") ?? (isPost ? "application/json" : "text/html; charset=utf-8");
  res.writeHead(r.status, { "content-type": ct, "cache-control": "no-store" });
  return void res.end(bodyText);
}

async function handleSelfConnect(res: ServerResponse, o: { provider: string; session: SessionClaims }): Promise<void> {
  const redirectUri = `${site().publicUrl}/v1/connectors/oauth/${encodeURIComponent(o.provider)}/callback`;
  const qs = new URLSearchParams({ principalId: o.session.sub, redirectUri, returnTo: "/connectors" });
  try {
    const r = await coreCall<{ authorizeUrl: string; message: string }>(
      "GET",
      `/v1/connectors/oauth/${encodeURIComponent(o.provider)}/start?${qs.toString()}`,
      { headers: portalIdentityHeaders(o.session.sub) },
    );
    const data = r.body;
    if (!r.ok) console.warn(`[portal] self-connect start returned HTTP ${r.status}: ${data.message ?? "no message"}`);
    if (data.authorizeUrl) {
      return redirect(res, 302, data.authorizeUrl);
    }
    return sendHtml(
      res,
      200,
      connectErrorHtml(data.message ?? "We couldn't start the connection. This app may not be configured."),
    );
  } catch (error) {
    reportFailure("portal: self-connect start", error);
    return sendHtml(
      res,
      502,
      connectErrorHtml("We couldn't reach the connection service. Please try again in a moment."),
    );
  }
}

function withIdentitySecret(): { identitySecret?: string } {
  const identitySecret = portalIdentitySecret();
  return identitySecret ? { identitySecret } : {};
}

function isOAuthPublicPassthrough(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  if (/^\/v1\/connectors\/oauth\/[^/]+\/callback$/.test(pathname)) return true;
  return false;
}

function hasAgentCapability(req: IncomingMessage): boolean {
  const value = req.headers["x-agent-capability"];
  return typeof value === "string" && value.trim().length > 0;
}

function hasSandboxModelCredential(req: IncomingMessage): boolean {
  const bearer = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  return (
    hasAgentCapability(req) ||
    (typeof bearer === "string" && /^Bearer\s+\S/i.test(bearer)) ||
    (typeof apiKey === "string" && apiKey.trim().length > 0)
  );
}

function isDeploymentLayerPassthrough(method: string, pathname: string): boolean {
  return (method === "GET" || method === "PUT") && pathname === "/v1/deployment-layer";
}

const server = createServer((req, res) => serveForHost(req, res, () => respond(req, res)));

function respond(req: IncomingMessage, res: ServerResponse): void {
  const startedAt = performance.now();
  let errorLogged = false;
  res.once("finish", () => {
    if (res.statusCode >= 500 && !errorLogged)
      console.error(
        "[portal] %d %s response (%d ms)",
        res.statusCode,
        METHODS.includes(req.method ?? "") ? req.method : "?",
        Math.round(performance.now() - startedAt),
      );
  });
  void handle(req, res).catch((err: unknown) => {
    errorLogged = true;
    reportBackendError(err);
    console.error("[portal] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    else res.end();
  });
}

const NEXT = Symbol("next");

interface RequestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  rawTarget: string;
  url: URL;
  pathname: string;
  crossOrigin?: string | undefined;
  session?: SessionClaims | null;
  authenticatedPrincipal?: string | undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const rawTarget = req.url ?? "/";

  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");

  const url = URL.parse(rawTarget, "http://portal.local");
  if (!url) return json(res, 400, { error: "bad_request", message: "illegal path" });
  const pathname = url.pathname;
  const ctx: RequestCtx = { req, res, method, rawTarget, url, pathname };
  for (const stage of [appHostRoutes, publicRoutes, sessionRoutes, passthroughRoutes, surfaceRoutes])
    if ((await stage(ctx)) !== NEXT) return;
}

async function appHostRoutes({ req, res }: RequestCtx): Promise<void | typeof NEXT> {
  const requestHost = (req.headers.host ?? "").toLowerCase().split(":")[0]!;
  const appsDomain = site().appsDomain?.toLowerCase();
  const appSuffix = appsDomain ? `.${appsDomain}` : undefined;
  if (appSuffix && (requestHost.endsWith(appSuffix) || requestHost === appsDomain)) {
    const label = requestHost.slice(0, -appSuffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return json(res, 404, { error: "not_found" });
    return proxyToAppHost(req, res, CORE, clientIpOf(req));
  }

  return NEXT;
}

async function publicRoutes(ctx: RequestCtx): Promise<void | typeof NEXT> {
  const { req, res, method, url, pathname } = ctx;
  ctx.crossOrigin = prepareCors(req, res, pathname, site().apiAllowedOrigins);
  if (ctx.crossOrigin && method === "OPTIONS") return answerPreflight(res);

  const brokerPath = brokerRouteFor(method, pathname);
  const reauthentication =
    (method === "GET" &&
      ["/auth/login", "/auth/callback", "/auth/trusted/login", "/auth/trusted/callback"].includes(pathname)) ||
    (method === "POST" && pathname === "/auth/logout") ||
    brokerPath !== null;
  if (currentSession(req)?.appOnly && !reauthentication) {
    return json(res, 403, { error: "app_only_session", message: "this sign-in only permits access to shared apps" });
  }

  void refreshSurfaceConfig();

  if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && pathname === CARD_SCENE_PATH) return serveCardScene(res);

  if (method === "GET" && (pathname === "/favicon.ico" || pathname === "/favicon.svg")) {
    return serveFavicon(
      res,
      {
        svg: site().faviconSvg ?? process.env.PORTAL_FAVICON_SVG,
        emoji: process.env.PORTAL_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F",
      },
      "max-age=86400",
    );
  }

  if (pathname === "/auth/login" && method === "GET") return authLogin(req, res, url);
  if (pathname === "/auth/callback" && method === "GET") return authCallback(req, res, url);
  if (pathname.startsWith("/auth/trusted/") && method === "GET") return trustedAuth(req, res, url);
  if (pathname === "/auth/desktop" || pathname === "/auth/desktop/redeem") return desktopLogin(req, res, url);
  if (pathname === "/auth/invite") return inviteLogin(req, res);
  if (pathname === "/auth/admin-login") return adminLogin(req, res);
  if (pathname === "/auth/signed-out" && method === "GET") {
    if (currentSession(req))
      return sendHtml(
        res,
        409,
        connectPage({
          title: "Still signed in",
          body: "Use Sign out from the account menu to end this session.",
          action: `<a class="btn primary" href="/">Back to the portal</a>`,
          icon: LOCK_ICON,
        }),
      );
    return sendHtml(
      res,
      200,
      connectPage({
        title: "Signed out",
        body: "You have signed out of this portal.",
        action: `<a class="btn primary" href="/auth/login">Sign in</a>`,
        icon: LOCK_ICON,
      }),
    );
  }
  if (pathname === "/auth/logout" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
    const { brokerUpstream, cookieDomain } = site();
    if (brokerUpstream && url.searchParams.get("everywhere") === "1") {
      const session = currentSession(req);
      if (!session || session.anon) return json(res, 401, { error: "sign in" });
      if (!portalIdentitySecret()) return json(res, 503, { error: "not_configured" });
      try {
        const response = await coreCall("POST", "/v1/auth/broker/sessions/revoke", {
          body: JSON.stringify({ email: session.sub }),
          headers: portalIdentityHeaders(session.sub),
          signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) {
          console.warn(`[portal] broker session revoke returned HTTP ${response.status}`);
          return json(res, 503, { error: "revocation_failed" });
        }
      } catch (error) {
        reportFailure("portal: broker session revoke", error);
        return json(res, 503, { error: "revocation_failed" });
      }
    }
    const signedOutSession = currentSession(req);
    const redirectTo = !brokerUpstream && signedOutSession && !signedOutSession.anon ? "/auth/signed-out" : "/";
    setSession(res, [
      ...(signedOutSession ? loginProviderCookie(signedOutSession.sub) : []),
      clearCookie("portal_impersonate", "/", SECURE_COOKIES),
      clearCookie("portal_trusted_tmp", "/auth/trusted", SECURE_COOKIES),
      clearCookie("portal_session", "/", SECURE_COOKIES, cookieDomain),
      clearCookie(FRAME_SESSION_COOKIE, "/", SECURE_COOKIES, cookieDomain),
      ...(cookieDomain
        ? [clearCookie("portal_session", "/", SECURE_COOKIES), clearCookie(FRAME_SESSION_COOKIE, "/", SECURE_COOKIES)]
        : []),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(brokerUpstream ? [clearCookie("qm_idp_session", AUTH_BROKER_PREFIX, true)] : []),
      ...(LOCAL_AUTH_BYPASS && isLoopbackAddress(req.socket.remoteAddress)
        ? [setCookie(LOCAL_LOGOUT_COOKIE, "1", { path: "/", maxAge: SESSION_TTL_S, secure: SECURE_COOKIES })]
        : []),
    ]);
    if (wantsHtml(req)) {
      return redirect(res, 303, redirectTo);
    }
    return json(res, 200, { ok: true, redirectTo });
  }

  if (brokerPath) {
    if (method !== "GET" && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    return proxyToUpstream(
      req,
      res,
      { baseUrl: site().brokerUpstream, path: brokerPath, search: url.search, forwardCookies: true },
      FORWARD_BROKER_HEADERS,
      {
        "x-qm-client-ip": clientIpOf(req),
        cookie: (req.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim())
          .filter((part) => /^qm_idp_session=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(part))
          .join("; "),
      },
    );
  }

  return NEXT;
}

async function sessionRoutes(ctx: RequestCtx): Promise<void | typeof NEXT> {
  const { req, res, method, url, pathname } = ctx;
  let session = renewSessionCookie(req, res) ?? currentSession(req);
  ctx.authenticatedPrincipal = session?.sub;
  if (session && !session.anon && (!pathname.startsWith("/auth/") || pathname.startsWith("/auth/impersonate"))) {
    const canonical = await canonicalPrincipal(session.sub);
    if (canonical === null) return identityUnavailable(req, res);
    session = { ...session, sub: canonical };
  }
  ctx.session = session;

  if (pathname === "/auth/impersonate" && method === "POST") {
    if (!session) return json(res, 401, { error: "sign in" });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (!(await isAdmin(session.sub))) return json(res, 403, { error: "forbidden", message: "admin access required" });
    const target = (url.searchParams.get("target") ?? "").trim();
    if (!target) return json(res, 400, { error: "bad_request", message: "target required" });
    if (target === session.sub || (await canonicalPrincipal(target)) === session.sub)
      return json(res, 400, { error: "bad_request", message: "cannot impersonate yourself" });
    const result = await coreImpersonate("start", session.sub, target);
    if (!result.ok) {
      const status = result.status === 403 || result.status === 400 ? result.status : 502;
      return json(res, status, {
        error: "impersonate_failed",
        message: result.message ?? "core refused impersonation",
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const imp: ImpersonationClaims = {
      k: "impersonate",
      actor: session.sub,
      target,
      org: session.org,
      iat: now,
      exp: now + IMPERSONATE_TTL_S,
    };
    setSession(res, [
      setCookie("portal_impersonate", seal(imp, site().impersonateKey), {
        path: "/",
        maxAge: IMPERSONATE_TTL_S,
        secure: SECURE_COOKIES,
      }),
    ]);
    return json(res, 200, { ok: true, target, displayName: result.displayName ?? target });
  }

  if (pathname === "/auth/impersonate/stop" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    const imp = openImpersonation(
      readCookie(req.headers.cookie, "portal_impersonate"),
      site().impersonateKey,
      Date.now(),
    );
    setSession(res, [clearCookie("portal_impersonate", "/", SECURE_COOKIES)]);
    if (session && imp && imp.actor === session.sub) await coreImpersonate("stop", session.sub, imp.target);
    if (wantsHtml(req)) {
      return redirect(res, 303, "/");
    }
    return json(res, 200, { ok: true });
  }

  return NEXT;
}

async function passthroughRoutes(ctx: RequestCtx): Promise<void | typeof NEXT> {
  const { req, res, method, rawTarget, url, pathname, session } = ctx;
  const rawPath = rawTarget.split("?")[0] ?? "";
  if (/%2f|%5c|%2e%2e|\\|\x00/i.test(rawPath) || rawPath.includes("//") || pathname.includes("/..")) {
    return json(res, 400, { error: "bad_request", message: "illegal path" });
  }

  if (
    (pathname === "/v1/slack/managed/installation" && (method === "POST" || method === "DELETE")) ||
    (pathname === "/v1/slack/managed/events" && method === "POST")
  ) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: "" }, [
      "authorization",
      "content-type",
      "content-length",
    ]);
  }

  if (method === "POST" && /^\/v1\/webhooks\/incoming\/[^/]+$/.test(pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_WEBHOOK_HEADERS);
  }

  if (method === "POST" && /^\/v1\/surfaces\/[^/]+\/events$/.test(pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      "content-type",
      "x-timestamp",
      "x-signature",
    ]);
  }

  const consentBounce = (): void => {
    res.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(`${pathname}${url.search}`)}` });
    return void res.end();
  };
  const redeem = /^\/connect\/redeem\/([^/]+)$/.exec(pathname);
  if (method === "GET" && redeem) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleConsentRedeem(res, {
      corePath: `/v1/connectors/oauth/consent/redeem/${redeem[1]}${url.search}`,
      session,
    });
  }
  const selfConnect = /^\/connect\/([^/]+)\/self-connect$/.exec(pathname);
  if (method === "GET" && selfConnect) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleSelfConnect(res, { provider: decodeURIComponent(selfConnect[1] ?? ""), session });
  }

  if (isOAuthPublicPassthrough(method, pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_OAUTH_HEADERS);
  }

  const dropForm = /^\/drop\/([^/]+)\/form$/.exec(pathname);
  if (method === "GET" && dropForm) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropForm[1]}/form${url.search}`,
      session,
    });
  }
  const dropSubmit = /^\/drop\/([^/]+)$/.exec(pathname);
  if (method === "POST" && dropSubmit) {
    if (!session)
      return json(res, 401, {
        error: "sign in",
        message: "your session expired, re-open the link, sign in, and paste again",
      });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (session.anon)
      return json(res, 403, { error: "forbidden", message: "secret drops are disabled for playground sessions" });
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropSubmit[1]}${url.search}`,
      session,
    });
  }

  if (
    ((method === "GET" || method === "POST") && pathname === "/v1/background-work") ||
    (method === "POST" && pathname === "/v1/deployment/live-session")
  ) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      ...FORWARD_DEPLOYMENT_LAYER_HEADERS,
      "authorization",
    ]);
  }

  if (isDeploymentLayerPassthrough(method, pathname)) {
    return proxyToUpstream(
      req,
      res,
      { baseUrl: CORE, path: pathname, search: url.search },
      FORWARD_DEPLOYMENT_LAYER_HEADERS,
    );
  }

  if (pathname.startsWith("/v1/sandbox-model/") && hasSandboxModelCredential(req)) {
    return proxyToUpstream(
      req,
      res,
      { baseUrl: CORE, path: pathname, search: url.search },
      FORWARD_SANDBOX_MODEL_HEADERS,
    );
  }

  if (pathname.startsWith("/v1/") && hasAgentCapability(req)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_AGENT_API_HEADERS);
  }

  if (pathname === "/v1" || pathname.startsWith("/v1/")) return json(res, 404, { error: "not_found" });

  return NEXT;
}

async function surfaceRoutes(ctx: RequestCtx): Promise<void> {
  const { req, res, method, url, pathname, crossOrigin, authenticatedPrincipal } = ctx;
  let session = ctx.session;
  const seg = pathname.split("/")[1] ?? "";
  if (seg === "web-ui") {
    const stripped = pathname.slice("/web-ui".length) || "/";
    return redirect(res, 308, `${stripped}${url.search}`);
  }
  if (!DEPLOYMENTS_ENABLED && (seg === "d" || seg === "deployments")) return json(res, 404, { error: "not_found" });
  const isDeployment = DEPLOYMENTS_ENABLED && (seg === "d" || seg === "deployments");

  if (
    method === "GET" &&
    (/^\/share\/external\/[a-f0-9-]{36}(?:\/files\/[a-f0-9-]{36})?$/.test(pathname) ||
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname))
  ) {
    return proxyToUpstream(req, res, { baseUrl: WEB_UI_UPSTREAM, path: pathname, search: url.search }, [
      "accept",
      "accept-encoding",
    ]);
  }

  if (!session) {
    if (method === "GET" && wantsHtml(req)) {
      if (PLAYGROUND) {
        session = await mintPlaygroundSession(req, res);
        if (!session) return sendHtml(res, 429, playgroundBusyHtml());
      } else {
        const returnTo = encodeURIComponent(`${pathname}${url.search}`);
        res.writeHead(302, { location: `/auth/login?returnTo=${returnTo}` });
        return void res.end();
      }
    } else {
      return json(res, 401, { error: "sign in", loginUrl: "/auth/login" });
    }
  }

  if (method !== "GET" && method !== "HEAD" && !crossOrigin && !sameOriginRequest(req)) {
    return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
  }

  if (isDeployment) {
    if (session.anon) return json(res, 403, { error: "forbidden", message: "sign in to view deployed apps" });
    const rest = pathname.slice(`/${seg}/`.length);
    const slash = rest.indexOf("/");
    const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const subPath = slash === -1 ? "/" : rest.slice(slash);
    if (!id) return json(res, 404, { error: "not_found" });
    return proxyToDeployment(req, res, {
      coreBase: CORE,
      id,
      subPath,
      search: url.search,
      principal: session.sub,
      signingSecret: coreSigningSecret(),
      ...withIdentitySecret(),
    });
  }

  const settingsPath = pathname === "/settings" || pathname.startsWith("/settings/") || seg === "admin";
  if (method === "GET" && wantsHtml(req) && !settingsPath) {
    await refreshSurfaceConfig();
    if (modelProviderConfigured() === false) {
      if (await isAdmin(session.sub)) {
        return redirect(res, 302, "/settings/onboarding");
      }
      return sendHtml(res, 503, notConfiguredHtml());
    }
  }

  let principal = session.sub;
  let impersonator: string | undefined;
  if (!crossOrigin) {
    const imp = openImpersonation(
      readCookie(req.headers.cookie, "portal_impersonate"),
      site().impersonateKey,
      Date.now(),
    );
    if (imp && imp.actor === session.sub && imp.org === session.org && (await isAdmin(session.sub))) {
      principal = imp.target;
      impersonator = session.sub;
    }
  }

  const requestedChannel = method === "GET" && wantsHtml(req) ? url.searchParams.get("ui") : null;
  if (requestedChannel !== null) {
    if (!isUiChannel(requestedChannel)) return json(res, 400, { error: "bad_request", message: "unknown ui channel" });
    url.searchParams.delete("ui");
    setSession(res, [
      requestedChannel === "live"
        ? clearCookie(UI_CHANNEL_COOKIE, "/", SECURE_COOKIES)
        : setCookie(UI_CHANNEL_COOKIE, requestedChannel, { secure: SECURE_COOKIES }),
    ]);
    return redirect(res, 302, `${pathname}${url.search}`);
  }
  const uiChannel = readCookie(req.headers.cookie, UI_CHANNEL_COOKIE);
  return proxyToSurface(req, res, {
    ...(uiChannel && isUiChannel(uiChannel) ? { uiChannel } : {}),
    upstreamBase: WEB_UI_UPSTREAM,
    forwardPath: pathname,
    search: url.search,
    cookieName: "webuiuser",
    principal,
    ...(!impersonator && session.name ? { displayName: session.name } : {}),
    ...(impersonator ? { impersonator } : {}),
    ...withIdentitySecret(),
    authenticatedPrincipal,
  });
}

function loopbackPort(upstream: string): number | undefined {
  try {
    const url = new URL(upstream);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/"
      ? Number(url.port)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startServer(port = PORT, host?: string): Promise<Server> {
  bootChecks();
  if (process.env.AUTH_EMBEDDED === "1") {
    const home = site();
    const brokerPort = loopbackPort(home.brokerUpstream);
    if (!brokerPort) throw new Error("Embedded auth requires a loopback broker upstream");
    const auth = await import("../../auth/src/index.ts");
    const broker = await auth.startServer({
      port: brokerPort,
      host: "127.0.0.1",
      ...(home.trustedLabel ? { trustedSignInLabel: home.trustedLabel } : {}),
    });
    server.once("close", () => broker.close());
    server.once("error", () => broker.close());
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
      console.log(`[portal] public front door on http://localhost:${port} → web-ui over 6PN (org ${coreOrgId()})`);
      if (!SESSION_SECRET)
        console.warn("[portal] PORTAL_SESSION_SECRET unset, using an INSECURE dev key (dev/test only)");
      if (!SECURE_COOKIES)
        console.warn("[portal] PORTAL_PUBLIC_URL is not https, cookies are NOT Secure (dev/test only)");
      if (LOCAL_AUTH_BYPASS)
        console.warn(
          `[portal] PORTAL_LOCAL_AUTH_BYPASS=1 -- using ${LOCAL_AUTH_PRINCIPAL} as the local session principal (dev/test only)`,
        );
      if (PLAYGROUND)
        console.warn(
          `[portal] PORTAL_PLAYGROUND=1 -- unauthenticated visitors get anonymous browser-pinned sessions (${PLAYGROUND_MINTS_PER_IP} mints per IP per ${PLAYGROUND_MINT_WINDOW_S}s); admin sign-in stays on /auth/login`,
        );
      if (PLAYGROUND && XFF_TRUSTED_HOPS === 0)
        console.warn(
          "[portal] playground mint limits key on the socket address — set PORTAL_XFF_TRUSTED_HOPS when behind a reverse proxy, or every visitor shares one bucket",
        );
    });
  });
  return server;
}

export { handle, server };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    reportBackendError(error);
    console.error("[portal] failed to start:", errMessage(error));
    process.exitCode = 1;
  });
}
