import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { createPersonNames } from "../../identity/person-names.ts";
import { appPathTenant, appGitTenant } from "./app-paths.ts";
import { SocksProxyAgent } from "socks-proxy-agent";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  connect as connectHttp2,
  constants as http2Constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type OutgoingHttpHeaders,
} from "node:http2";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { appView, type App, type DeployInput, type RedeployInput } from "../app.ts";
import { errMessage, reportFailureAs, swallowAs } from "../../util/errors.ts";
import { escapeHtml, relayStream } from "../../../plugins/chassis/src/http.ts";
import { canonicalPayload } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { frameAncestorsDirective, sendJson, UNTRUSTED_CONTENT_SANDBOX_CSP, verifyOrReject } from "../http.ts";
import { mintPortalIdentity, verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../auth/portal-identity.ts";
import { audit, authorizeAdmin, exportTokenAccepted, isObj, orgScope } from "./shared.ts";
import { personalScope, scopeId, type Permission } from "../../types.ts";
import { tenantOf, type ApiCtx, type BaseCtx, type Route } from "./route.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { verifyDeployGitAccess, viewerIdentityKey } from "../../deploy/access-token.ts";
import { appAnnotationAsset } from "../../deploy/app-annotate.ts";
import { appAccess } from "../../deploy/app-access.ts";
import { APP_SHELL_PATH_PREFIX, appShellHtml } from "../../deploy/app-shell.ts";
import type { AppViewAuthMode } from "../../deploy/page-views.ts";
import { principalDestination } from "../../reach/reach.ts";
import { FRAME_SESSION_COOKIE, portalSession, portalSessionFrom } from "../../deploy/viewer-session.ts";
import { appNameFromLabel, labelOfAppHost } from "../../tenants/app-handle.ts";
import { isDnsLabel } from "../../../plugins/chassis/src/dns-label.ts";
import { tenantAppHandle } from "../../tenants/settings.ts";
import { appSubdomainUrlOf } from "../../deploy/deploy-store.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { EMBED_ANCESTORS_HINT, parseEmbedAncestors } from "../../deploy/embed-ancestors.ts";
import { proxyHeaders } from "../../util/http-proxy.ts";
import { relayWebSocket } from "../../../plugins/chassis/src/websocket-relay.ts";
import { appGitParts, isAppGitRoute } from "../../../plugins/chassis/src/app-git.ts";

function appProxyAgent(port?: number): { agent?: SocksProxyAgent } {
  if (port === undefined) return {};
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid app SOCKS port");
  return { agent: new SocksProxyAgent(`socks5h://127.0.0.1:${port}`, { keepAlive: false }) };
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObj(v) && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

function isRedeployInput(b: unknown): b is RedeployInput {
  return (
    isObj(b) &&
    typeof b.entrypoint === "string" &&
    Array.isArray(b.files) &&
    (b.homeFiles === undefined || Array.isArray(b.homeFiles)) &&
    (b.env === undefined || isStringRecord(b.env)) &&
    b.stampEnv === undefined &&
    b.actor === undefined &&
    (b.alwaysOn === undefined || typeof b.alwaysOn === "boolean")
  );
}

function isDeployInput(b: unknown): b is DeployInput {
  return isObj(b) && typeof b.ownerScopeId === "string" && typeof b.createdBy === "string" && isRedeployInput(b);
}

async function proxyApp(ctx: BaseCtx): Promise<void> {
  const { req, res, app, deps, secret, auth, url, pathname, method } = ctx;
  const rest = pathname.slice("/d/".length);
  const slash = rest.indexOf("/");
  const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  const subPath = slash === -1 ? "/" : rest.slice(slash);
  const principal = (req.headers["x-as-principal"] as string) ?? "";
  if (
    !(await verifyOrReject(
      req,
      res,
      secret,
      auth,
      canonicalPayload(method, pathname + url.search, principal),
      false,
      ctx.allowUnsignedSourceAuth,
    ))
  )
    return;
  if (deps.requireSignedPortalIdentity || deps.production) {
    const psecret = deps.portalIdentitySecret ?? secret;
    const rawTok = req.headers[PORTAL_IDENTITY_HEADER];
    const tok = Array.isArray(rawTok) ? rawTok[0] : rawTok;
    const actor = psecret && tok ? await verifyPortalIdentity(tok, psecret, Date.now()) : null;
    if (!psecret || !actor || actor.p !== principal)
      return sendJson(res, 403, { error: "forbidden", message: "portal identity required" });
    if (deps.identity) {
      await deps.identity.refresh();
      if (deps.identity.classify(actor.p).type !== "internal") {
        return sendJson(res, 403, { error: "forbidden", message: "principal is no longer active" });
      }
    }
  }
  if (
    deps.deployGateSecret &&
    deps.deployAppsSessionSecret &&
    method === "GET" &&
    String(req.headers["sec-fetch-dest"] ?? "") === "document"
  ) {
    const d = await app.getApp(id).catch(swallowAs("apps: load app", null));
    const subdomainUrl = d && appSubdomainUrlOf(d, deps.deployAppsDomain);
    if (subdomainUrl) {
      res.writeHead(302, {
        location: new URL(`${subPath}${url.search}`, subdomainUrl).href,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
  }
  const reach = await app.reachApp(id, principal);
  return proxyReach(ctx, reach, subPath, principal, { sandbox: true });
}

function adminAppProxyParts(pathname: string): { id: string; subPath: string } | null {
  const prefix = "/v1/admin/apps/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const marker = "/proxy";
  const markerAt = rest.indexOf(marker);
  if (markerAt < 0) return null;
  const after = rest.slice(markerAt + marker.length);
  if (after && !after.startsWith("/")) return null;
  try {
    return { id: decodeURIComponent(rest.slice(0, markerAt)), subPath: after || "/" };
  } catch {
    return null;
  }
}

async function proxyAdminApp(ctx: BaseCtx): Promise<void> {
  const { req, res, app, deps, secret, auth, url, pathname, method } = ctx;
  const parts = adminAppProxyParts(pathname);
  if (!parts) return sendJson(res, 404, { error: "not_found" });
  const actorHeader = (req.headers["x-admin-actor"] as string) ?? "";
  if (
    !(await verifyOrReject(
      req,
      res,
      secret,
      auth,
      canonicalPayload(method, pathname + url.search, actorHeader),
      false,
      ctx.allowUnsignedSourceAuth,
    ))
  )
    return;
  const found = await app.getApp(parts.id);
  const publishedApp = found?.id === parts.id ? found : undefined;
  const actor = await authorizeAdmin(
    { req, res, deps, capability: null, tenant: ctx.tenant },
    publishedApp?.ownerScopeId ?? orgScope(deps),
  );
  if (!actor) return;
  if (!publishedApp) return sendJson(res, 404, { error: "not_found" });
  audit(ctx, {
    principalId: actor.id,
    action: "app.visit",
    resource: publishedApp.id,
    scopeLabel: publishedApp.ownerScopeId,
  });
  const reach = await app.reachApp(parts.id, "", { bypassAcl: true });
  return proxyReach(ctx, reach, parts.subPath, undefined, { sandbox: true });
}

const GATEWAY_AUTH_HEADERS = [
  "x-qm-app-host",
  "x-qm-client-ip",
  "x-signature",
  "x-timestamp",
  "x-as-principal",
  "x-admin-actor",
  "x-agent-capability",
  PORTAL_IDENTITY_HEADER,
];

const PROXY_BUFFER_MAX_BYTES = 10_000_000;
const AGENT_FETCH_DEFAULT_MAX_BYTES = 256 * 1024;
const AGENT_FETCH_MAX_BYTES = 1024 * 1024;
const AGENT_FETCH_TIMEOUT_MS = 10_000;
const AGENT_FETCH_MAX_REDIRECTS = 5;

const THROTTLE_SHIELD_MS = 5_000;
const throttledUpstreams = new Map<string, number>();

function armThrottleShield(upstreamKey: string, statusCode: number, upstream: NodeJS.EventEmitter): void {
  if (statusCode !== 429) return;
  let sawBody = false;
  upstream.on("data", () => (sawBody = true));
  upstream.on("end", () => {
    if (sawBody) return;
    if (throttledUpstreams.size > 1000) {
      for (const [k, until] of throttledUpstreams) if (Date.now() >= until) throttledUpstreams.delete(k);
    }
    throttledUpstreams.set(upstreamKey, Date.now() + THROTTLE_SHIELD_MS);
  });
}
const HTTP2_IDLE_TIMEOUT_MS = 60_000;
const HTTP2_DRAIN_TIMEOUT_MS = 5_000;
interface AppHttp2Connection {
  session: ClientHttp2Session;
  activeStreams: number;
  idleTimer?: NodeJS.Timeout;
  retiring?: boolean;
}
const appHttp2Sessions = new Map<string, AppHttp2Connection>();

const TRACE_HEADERS = ["sentry-trace", "baggage", "traceparent", "tracestate"];

function forwardableHeaders(req: BaseCtx["req"]): Record<string, string | string[]> {
  const out = proxyHeaders(req.headers, ["host", ...GATEWAY_AUTH_HEADERS, ...TRACE_HEADERS]);
  const kept = String(out.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^(?:dpl_access|dpl_owner|portal_session|portal_session_x)\s*=/.test(part));
  if (kept.length) out.cookie = kept.join("; ");
  else delete out.cookie;
  return out;
}

function cspMentionsFrameAncestors(value: string | string[] | undefined): boolean {
  if (!value) return false;
  return (Array.isArray(value) ? value : [value]).some((v) => /frame-ancestors/i.test(v));
}

function gatewaySafeResponseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
  sandbox = false,
  frameAncestors?: readonly string[],
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || name.startsWith(":")) continue;
    normalized[name] = typeof value === "number" ? String(value) : value;
  }
  const out = proxyHeaders(normalized);
  const cookies = out["set-cookie"];
  if (cookies) {
    const values = Array.isArray(cookies) ? cookies : [cookies];
    const kept = values.filter(
      (cookie) => !/^\s*(?:dpl_access|dpl_owner|portal_session|portal_session_x)\s*=/i.test(cookie),
    );
    if (kept.length) out["set-cookie"] = kept;
    else delete out["set-cookie"];
  }
  delete out["clear-site-data"];
  if (sandbox) {
    const existing = out["content-security-policy"];
    out["content-security-policy"] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), UNTRUSTED_CONTENT_SANDBOX_CSP]
      : UNTRUSTED_CONTENT_SANDBOX_CSP;
  }
  if (frameAncestors?.length && !out["x-frame-options"] && !cspMentionsFrameAncestors(out["content-security-policy"])) {
    const directive = frameAncestorsDirective(frameAncestors);
    const existing = out["content-security-policy"];
    out["content-security-policy"] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), directive]
      : directive;
  }
  return out;
}

function appHttp2Session(origin: string): AppHttp2Connection {
  const existing = appHttp2Sessions.get(origin);
  if (existing && !existing.session.closed && !existing.session.destroyed) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return existing;
  }
  const session = connectHttp2(origin);
  session.unref();
  const connection: AppHttp2Connection = { session, activeStreams: 0 };
  appHttp2Sessions.set(origin, connection);
  const remove = (): void => {
    if (appHttp2Sessions.get(origin) === connection) appHttp2Sessions.delete(origin);
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = undefined;
  };
  session.on("error", () => {
    remove();
    session.destroy();
  });
  session.on("close", remove);
  session.on("goaway", () => retireAppHttp2Connection(origin, connection));
  return connection;
}

function retireAppHttp2Connection(origin: string, connection: AppHttp2Connection): void {
  if (appHttp2Sessions.get(origin) === connection) appHttp2Sessions.delete(origin);
  if (connection.retiring || connection.session.destroyed) return;
  connection.retiring = true;
  connection.session.close();
  const timer = setTimeout(() => connection.session.destroy(), HTTP2_DRAIN_TIMEOUT_MS);
  timer.unref();
  connection.session.once("close", () => clearTimeout(timer));
}

function releaseAppHttp2Stream(origin: string, connection: AppHttp2Connection): void {
  connection.activeStreams--;
  if (connection.activeStreams !== 0 || appHttp2Sessions.get(origin) !== connection) return;
  connection.idleTimer = setTimeout(() => connection.session.close(), HTTP2_IDLE_TIMEOUT_MS);
  connection.idleTimer.unref();
}

function checkAppHttp2Session(connection: AppHttp2Connection): void {
  const timer = setTimeout(() => connection.session.destroy(), 1_000);
  timer.unref();
  try {
    connection.session.ping((error) => {
      clearTimeout(timer);
      if (error) connection.session.destroy();
    });
  } catch {
    clearTimeout(timer);
    connection.session.destroy();
  }
}

function proxyReachHttp2(
  ctx: BaseCtx,
  endpoint: Awaited<ReturnType<App["reachApp"]>> & { status: "ok" },
  subPath: string,
  headers: Record<string, string | string[]>,
  bufferedBody: Buffer | null,
  sandbox: boolean,
  frameAncestors?: readonly string[],
): void {
  const { req, res, deps, url, method } = ctx;
  const { host, port, tls } = endpoint.endpoint;
  const origin = `${tls ? "https" : "http"}://${host}:${port}`;
  const requestHeaders: OutgoingHttpHeaders = {
    ":method": method,
    ":path": subPath + url.search,
    ":authority": tls ? host : `${host}:${port}`,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "host") requestHeaders[name.toLowerCase()] = value;
  }
  const replaySafe =
    (method === "GET" || method === "HEAD") && bufferedBody === null && headers["content-length"] === undefined;
  let current: ClientHttp2Stream | undefined;
  res.on("close", () => {
    if (current && !current.closed) current.close(http2Constants.NGHTTP2_CANCEL);
  });
  req.on("error", () => current?.close(http2Constants.NGHTTP2_CANCEL));
  req.on("aborted", () => current?.close(http2Constants.NGHTTP2_CANCEL));

  const start = (retried: boolean): void => {
    const connection = appHttp2Session(origin);
    let up: ClientHttp2Stream;
    try {
      up = connection.session.request(requestHeaders);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const sessionFailed =
        connection.session.closed ||
        connection.session.destroyed ||
        code === "ERR_HTTP2_GOAWAY_SESSION" ||
        code === "ERR_HTTP2_OUT_OF_STREAMS" ||
        code === "ERR_HTTP2_INVALID_SESSION";
      if (sessionFailed) retireAppHttp2Connection(origin, connection);
      if (replaySafe && !retried && sessionFailed && !res.headersSent && !res.destroyed && !res.writableEnded)
        return start(true);
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, 502, { error: "bad_gateway", message: "app unreachable" });
      return;
    }
    current = up;
    connection.activeStreams++;
    let responseStarted = false;
    let failureHandled = false;
    const fail = (error?: unknown): void => {
      if (failureHandled) return;
      failureHandled = true;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const sessionFailed =
        connection.session.closed ||
        connection.session.destroyed ||
        code === "ECONNRESET" ||
        code === "ERR_HTTP2_SESSION_ERROR" ||
        code === "ERR_HTTP2_INVALID_SESSION";
      if (sessionFailed) retireAppHttp2Connection(origin, connection);
      const moved = appHttp2Sessions.get(origin) !== connection;
      if (
        !responseStarted &&
        replaySafe &&
        !retried &&
        (sessionFailed || moved) &&
        !res.headersSent &&
        !res.destroyed &&
        !res.writableEnded
      ) {
        up.setTimeout(0);
        if (!up.closed) up.close(http2Constants.NGHTTP2_CANCEL);
        return start(true);
      }
      if (res.destroyed || res.writableEnded) return;
      if (wantsWarmingPage(req, method) && !res.headersSent) sendWarmingPage(res);
      else if (!res.headersSent) sendJson(res, 502, { error: "bad_gateway", message: "app unreachable" });
      else res.destroy();
    };
    up.once("close", () => {
      releaseAppHttp2Stream(origin, connection);
      if (!responseStarted || !up.readableEnded || up.rstCode !== http2Constants.NGHTTP2_NO_ERROR) fail();
      else if (!failureHandled && !res.destroyed && !res.writableEnded) res.end();
    });
    const htmlNav = wantsWarmingPage(req, method);
    up.setTimeout(
      warmingDialTimeoutMs(`${host}:${port}`, htmlNav, deps.deployDialTimeoutMs ?? CONFIG_DEFAULTS.deployDialTimeoutMs),
      () => {
        if (failureHandled) return;
        failureHandled = true;
        if (htmlNav && !res.headersSent) sendWarmingPage(res);
        else if (!res.headersSent) sendJson(res, 504, { error: "gateway_timeout", message: "app did not respond" });
        else res.end();
        up.close(http2Constants.NGHTTP2_CANCEL);
        checkAppHttp2Session(connection);
      },
    );
    up.on("response", (responseHeaders) => {
      if (failureHandled || res.headersSent || res.destroyed || res.writableEnded) {
        up.close(http2Constants.NGHTTP2_CANCEL);
        return;
      }
      responseStarted = true;
      up.setTimeout(0);
      markUpstreamUp(`${host}:${port}`);
      armThrottleShield(`${host}:${port}`, Number(responseHeaders[":status"] ?? 0), up);
      const status = Number(responseHeaders[":status"] ?? 502);
      const safeHeaders = gatewaySafeResponseHeaders(responseHeaders, sandbox, frameAncestors);
      if (frameAncestors !== undefined) res.removeHeader("content-security-policy");
      res.writeHead(status, safeHeaders);
      relayStream(up, res, { end: false });
    });
    up.on("error", fail);
    if (replaySafe) up.end();
    else if (bufferedBody !== null) up.end(bufferedBody);
    else relayStream(req, up);
  };
  start(false);
}

const WARM_RECENT_MS = 60_000;
const COLD_FIRST_BYTE_TIMEOUT_MS = 4_000;
const upstreamLastOk = new Map<string, number>();

function markUpstreamUp(upstreamKey: string): void {
  if (upstreamLastOk.size > 1000) {
    for (const [k, at] of upstreamLastOk) if (Date.now() - at > WARM_RECENT_MS) upstreamLastOk.delete(k);
  }
  upstreamLastOk.set(upstreamKey, Date.now());
}

function wantsWarmingPage(req: BaseCtx["req"], method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const dest = String(req.headers["sec-fetch-dest"] ?? "");
  if (dest && dest !== "document") return false;
  return String(req.headers.accept ?? "").includes("text/html");
}

function warmingDialTimeoutMs(upstreamKey: string, htmlNav: boolean, configuredMs: number): number {
  if (!htmlNav) return configuredMs;
  const lastOk = upstreamLastOk.get(upstreamKey) ?? 0;
  if (Date.now() - lastOk < WARM_RECENT_MS) return configuredMs;
  return Math.min(configuredMs, COLD_FIRST_BYTE_TIMEOUT_MS);
}

const WARMING_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting up…</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fafaf8;color:#333}
  .card{text-align:center;padding:2rem}
  .spinner{width:28px;height:28px;margin:0 auto 1rem;border:3px solid #eee;border-top-color:#f26522;
    border-radius:50%;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.1rem;font-weight:600;margin:0 0 .35rem}
  p{margin:0;color:#777}
</style></head>
<body><div class="card"><div class="spinner"></div><h1>Starting up&hellip;</h1>
<p id="msg"></p></div>
<script>
  var started = Date.now();
  function retry(){
    if (Date.now() - started > 120000) {
      document.getElementById("msg").textContent = "Still not responding — the app may have crashed.";
      return;
    }
    fetch(location.href, { method: "HEAD", cache: "no-store" }).then(function(r){
      if (r.status !== 503 && r.status !== 502 && r.status !== 504) location.reload();
      else setTimeout(retry, 2000);
    }).catch(function(){ setTimeout(retry, 2000); });
  }
  setTimeout(retry, 1500);
</script></body></html>`;

function sendWarmingPage(res: BaseCtx["res"]): void {
  if (res.headersSent || res.destroyed || res.writableEnded) {
    res.end();
    return;
  }
  res.writeHead(503, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "2",
  });
  res.end(WARMING_PAGE_HTML);
}

async function proxyReach(
  ctx: BaseCtx,
  reach: Awaited<ReturnType<App["reachApp"]>>,
  subPath: string,
  viewer?: string,
  opts?: { sandbox?: boolean; frameAncestors?: readonly string[] },
): Promise<void> {
  const { req, res, deps, url, method } = ctx;
  if (res.destroyed) return;
  if (reach.status === "not_found") return sendJson(res, 404, { error: "not_found" });
  if (reach.status === "denied") return sendJson(res, 403, { error: "forbidden", message: "not in the app's scope" });
  const { host, port } = reach.endpoint;
  const upstreamKey = `${host}:${port}`;
  const shieldedUntil = throttledUpstreams.get(upstreamKey) ?? 0;
  if (Date.now() < shieldedUntil) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(Math.max(1, Math.ceil((shieldedUntil - Date.now()) / 1000))),
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ error: "throttled", message: "app is rate limited upstream" }));
    return;
  }
  const requestFn = reach.endpoint.tls ? httpsRequest : httpRequest;
  const hostHeader = reach.endpoint.tls ? host : `${host}:${port}`;
  let bufferedBody: Buffer | null = null;
  const headers: Record<string, string | string[]> = {
    ...forwardableHeaders(req),
    host: hostHeader,
    ...reach.endpoint.proxyHeaders,
  };

  if (viewer && ctx.secret) {
    headers[PORTAL_IDENTITY_HEADER] = await mintPortalIdentity(
      { p: viewer, exp: Date.now() + 60_000 },
      viewerIdentityKey(ctx.secret, reach.id),
    );
  }
  if (ctx.upgrade) {
    const target = {
      tls: reach.endpoint.tls === true,
      hostname: host,
      port,
      path: subPath + url.search,
      headers,
      timeoutMs: deps.deployDialTimeoutMs ?? CONFIG_DEFAULTS.deployDialTimeoutMs,
      ...appProxyAgent(reach.endpoint.socksProxyPort),
    };
    relayWebSocket(res, ctx.upgrade, target, "deployment-websocket");
    return;
  }
  if (/(?:^|,)\s*chunked\s*$/i.test(String(req.headers["transfer-encoding"] ?? ""))) {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > PROXY_BUFFER_MAX_BYTES)
          return sendJson(res, 413, { error: "payload_too_large", message: "request body too large" });
        chunks.push(chunk as Buffer);
      }
    } catch {
      res.destroy();
      return;
    }
    bufferedBody = Buffer.concat(chunks);
    headers["content-length"] = String(bufferedBody.length);
  }
  if (res.destroyed) return;
  if (reach.endpoint.httpVersion === "2") {
    proxyReachHttp2(ctx, reach, subPath, headers, bufferedBody, opts?.sandbox ?? false, opts?.frameAncestors);
    return;
  }
  const htmlNav = wantsWarmingPage(req, method);
  const up = requestFn(
    {
      hostname: host,
      port,
      path: subPath + url.search,
      method,
      headers,
      ...appProxyAgent(reach.endpoint.socksProxyPort),
    },
    (upRes) => {
      up.setTimeout(0);
      markUpstreamUp(upstreamKey);
      armThrottleShield(upstreamKey, upRes.statusCode ?? 0, upRes);
      const headers = gatewaySafeResponseHeaders(upRes.headers, opts?.sandbox ?? false, opts?.frameAncestors);
      if (opts?.frameAncestors !== undefined) res.removeHeader("content-security-policy");
      res.writeHead(upRes.statusCode ?? 502, headers);
      relayStream(upRes, res);
    },
  );
  const dialMs = warmingDialTimeoutMs(
    upstreamKey,
    htmlNav,
    deps.deployDialTimeoutMs ?? CONFIG_DEFAULTS.deployDialTimeoutMs,
  );
  up.setTimeout(dialMs, () => {
    if (htmlNav && !res.headersSent) sendWarmingPage(res);
    else if (!res.headersSent) sendJson(res, 504, { error: "gateway_timeout", message: "app did not respond" });
    else res.end();
    up.destroy();
  });
  up.on("error", () => {
    if (htmlNav && !res.headersSent) sendWarmingPage(res);
    else if (!res.headersSent) sendJson(res, 502, { error: "bad_gateway", message: "app unreachable" });
    else res.end();
  });
  if (bufferedBody !== null) up.end(bufferedBody);
  else relayStream(req, up);
  return;
}

interface AppFetchResult {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: Buffer;
  truncated: boolean;
}

function boundedResponseBody(
  stream: NodeJS.ReadableStream & { destroy(error?: Error): void },
  maxBytes: number,
  timeoutMs = AGENT_FETCH_TIMEOUT_MS,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => stream.destroy(new Error("timeout")), Math.max(1, timeoutMs));
    timeout.unref();
    const finish = (truncated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ body: Buffer.concat(chunks, Math.min(size, maxBytes)), truncated });
      if (truncated) stream.destroy();
    };
    stream.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const remaining = maxBytes - size;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      size += Math.min(chunk.length, Math.max(remaining, 0));
      if (chunk.length > remaining) finish(true);
    });
    stream.on("end", () => finish(false));
    const fail = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error ?? new Error("upstream aborted"));
    };
    stream.on("error", fail);
    stream.on("aborted", fail);
  });
}

function appFetchHttp1(
  endpoint: Awaited<ReturnType<App["reachApp"]>> & { status: "ok" },
  path: string,
  maxBytes: number,
  deadline: number,
): Promise<AppFetchResult> {
  return new Promise((resolve, reject) => {
    const { host, port, tls, proxyHeaders } = endpoint.endpoint;
    const requestFn = tls ? httpsRequest : httpRequest;
    const request = requestFn(
      {
        hostname: host,
        port,
        path,
        method: "GET",
        headers: { ...proxyHeaders, "accept-encoding": "identity" },
        ...appProxyAgent(endpoint.endpoint.socksProxyPort),
      },
      async (response) => {
        clearTimeout(timeout);
        try {
          const collected = await boundedResponseBody(response, maxBytes, deadline - Date.now());
          resolve({ status: response.statusCode ?? 502, headers: response.headers, ...collected });
        } catch (error) {
          reject(error);
        }
      },
    );
    const timeout = setTimeout(() => request.destroy(new Error("timeout")), Math.max(1, deadline - Date.now()));
    timeout.unref();
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

function appFetchHttp2(
  endpoint: Awaited<ReturnType<App["reachApp"]>> & { status: "ok" },
  path: string,
  maxBytes: number,
  deadline: number,
): Promise<AppFetchResult> {
  return new Promise((resolve, reject) => {
    const { host, port, tls, proxyHeaders } = endpoint.endpoint;
    const origin = `${tls ? "https" : "http"}://${host}:${port}`;
    const connection = appHttp2Session(origin);
    const stream = connection.session.request({
      ":method": "GET",
      ":path": path,
      ":authority": tls ? host : `${host}:${port}`,
      "accept-encoding": "identity",
      ...proxyHeaders,
    });
    connection.activeStreams++;
    let headers: Record<string, string | string[] | number | undefined> = {};
    stream.on("response", (responseHeaders) => {
      headers = responseHeaders;
    });
    boundedResponseBody(stream, maxBytes, deadline - Date.now())
      .then((collected) => resolve({ status: Number(headers[":status"] ?? 502), headers, ...collected }))
      .catch(reject);
    stream.once("close", () => releaseAppHttp2Stream(origin, connection));
    stream.end();
  });
}

function normalizedAppFetchPath(raw: string | null): string | null {
  const path = raw ?? "/";
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")) return null;
  try {
    let decodedPath = path.split("?", 1)[0]!;
    for (let depth = 0; depth < 8; depth++) {
      const next = decodeURIComponent(decodedPath);
      if (
        next.includes("\\") ||
        next.includes("\0") ||
        next.split("/").some((segment) => segment === "." || segment === "..")
      )
        return null;
      if (next === decodedPath) break;
      if (depth === 7) return null;
      decodedPath = next;
    }
    const normalized = new URL(path, "http://deployment.invalid");
    if (normalized.origin !== "http://deployment.invalid") return null;
    return normalized.pathname + normalized.search;
  } catch {
    return null;
  }
}

function redirectPath(
  endpoint: Awaited<ReturnType<App["reachApp"]>> & { status: "ok" },
  location: string | string[] | number | undefined,
  currentPath: string,
): string | null {
  if (typeof location !== "string") return null;
  try {
    const { host, port, tls } = endpoint.endpoint;
    const origin = `${tls ? "https" : "http"}://${host}:${port}`;
    const next = new URL(location, `${origin}${currentPath}`);
    if (next.origin !== origin) return null;
    return normalizedAppFetchPath(next.pathname + next.search);
  } catch {
    return null;
  }
}

async function fetchAppResponse(
  endpoint: Awaited<ReturnType<App["reachApp"]>> & { status: "ok" },
  initialPath: string,
  maxBytes: number,
): Promise<AppFetchResult> {
  let path = initialPath;
  const deadline = Date.now() + AGENT_FETCH_TIMEOUT_MS;
  for (let redirects = 0; ; redirects++) {
    const response =
      endpoint.endpoint.httpVersion === "2"
        ? await appFetchHttp2(endpoint, path, maxBytes, deadline)
        : await appFetchHttp1(endpoint, path, maxBytes, deadline);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= AGENT_FETCH_MAX_REDIRECTS) throw new Error("too many redirects");
    const next = redirectPath(endpoint, response.headers.location, path);
    if (!next) throw new Error("redirect leaves app");
    path = next;
  }
}

export async function proxyAppSubdomain(ctx: BaseCtx): Promise<boolean> {
  const { req, res, app, deps, url, pathname } = ctx;
  const appsDomain = deps.deployAppsDomain;
  const gateSecret = deps.deployGateSecret;
  const fromAppHost = req.headers["x-qm-app-host"] === "1";
  if (!appsDomain || !gateSecret) {
    if (!fromAppHost) return false;
    sendJson(res, 503, { error: "unavailable", message: "app gateway is not configured" });
    return true;
  }
  const label = labelOfAppHost(req.headers.host, appsDomain);
  if (label === undefined) {
    if (!fromAppHost) return false;
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  const rawHost = `${label}.${appsDomain.toLowerCase()}`;
  const handle = tenantAppHandle();
  const slug = appNameFromLabel(label, handle);
  if (!slug || !isDnsLabel(label)) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  if (ctx.upgrade || !["GET", "HEAD", "OPTIONS"].includes(ctx.method)) {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if ((origin !== undefined && origin !== `https://${rawHost}`) || (site !== undefined && site !== "same-origin")) {
      sendJson(res, 403, { error: "forbidden", message: "cross-origin app request refused" });
      return true;
    }
  }
  const safePathname =
    pathname.startsWith("/") && !pathname.startsWith("//") && !/[\\\x00-\x1f]/.test(pathname) ? pathname : "/";
  const staleAccess = url.searchParams.has("access");
  url.searchParams.delete("access");
  const staleOwner = url.searchParams.has("owner");
  url.searchParams.delete("owner");
  const signInAttempted = url.searchParams.get("dpl_signin") === "1";
  url.searchParams.delete("dpl_signin");
  const cleanUrlRedirect = (): void => {
    const qs = url.searchParams.toString();
    res.writeHead(302, { location: safePathname + (qs ? `?${qs}` : ""), "cache-control": "no-store" });
    res.end();
  };
  if ((staleAccess || staleOwner) && ctx.method === "GET") {
    cleanUrlRedirect();
    return true;
  }
  const publishedApp = await app.getApp(slug).catch(swallowAs("apps: load app", null));
  const externalAllowed = publishedApp
    ? await externalAppSharingAllowed(deps.featureFlags, publishedApp.ownerScopeId)
    : false;
  const isPublic = publishedApp?.public === true && externalAllowed;
  const sessionSecret = deps.deployAppsSessionSecret;
  const loginUrl = deps.deployAppsLoginUrl;
  const wantsHtml = ctx.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
  let session = sessionSecret ? portalSession(req.headers.cookie, sessionSecret, Date.now()) : null;
  const dest = req.headers["sec-fetch-dest"];
  const site = req.headers["sec-fetch-site"];
  const framed = dest === "iframe" || site === "same-origin";
  const embedAncestors = framed ? (publishedApp?.embedAncestors ?? []) : [];
  if (!session && sessionSecret && embedAncestors.length) {
    session = portalSessionFrom(req.headers.cookie, FRAME_SESSION_COOKIE, sessionSecret, Date.now());
  }
  if (session?.t !== undefined && session.t !== ctx.tenant?.id) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  const sub = session?.sub;
  if (embedAncestors.length) res.setHeader("content-security-policy", frameAncestorsDirective(embedAncestors));
  if (!isPublic && (!sessionSecret || !loginUrl)) {
    sendJson(res, 503, { error: "unavailable", message: "sign-in is not configured for app subdomains" });
    return true;
  }
  if (!sub && !isPublic) {
    const qs = url.searchParams.toString();
    const returnTo = `https://${rawHost}${safePathname}?${qs ? `${qs}&` : ""}dpl_signin=1`;
    const signIn = handle
      ? `${loginUrl}/auth/host?to=${encodeURIComponent(returnTo)}`
      : `${loginUrl}${deps.deployAppsLoginPath ?? "/auth/login"}?returnTo=${encodeURIComponent(returnTo)}`;
    if (!wantsHtml) {
      sendJson(res, 401, { error: "unauthorized", message: "sign-in required", loginUrl: signIn });
    } else if (signInAttempted) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(signInFailedHtml(signIn));
    } else {
      res.writeHead(302, { location: signIn, "cache-control": "no-store" });
      res.end();
    }
    return true;
  }
  const bareApp = url.searchParams.get("__qm_no_shell") === "1";
  url.searchParams.delete("__qm_no_shell");
  const isTopDocument = String(req.headers["sec-fetch-dest"] ?? "") === "document";
  const isShellRequest = pathname.startsWith(APP_SHELL_PATH_PREFIX);
  const canManage = sub && !session?.appOnly ? await app.canManageApp(slug, { actorId: sub }) : false;
  let authenticatedPermission: Permission | null = null;
  if (sub && publishedApp) {
    if (session?.appOnly) {
      await deps.identity?.refresh();
      if (
        externalAllowed &&
        deps.identity?.deactivationSource(sub) !== "manual" &&
        (await app.appGrantees(publishedApp.id)).some(
          (grant) => grant.scope === scopeId("personal", sub.trim().toLowerCase()) && grant.permission === "read",
        )
      )
        authenticatedPermission = "read";
    } else {
      authenticatedPermission = await app.effectiveAppPermission(publishedApp, sub);
    }
  }
  const isPageLoad =
    ctx.method === "GET" &&
    wantsHtml &&
    (dest === undefined || dest === "document" || (dest === "iframe" && site !== "same-origin"));
  const recordPageView = (authMode: AppViewAuthMode): void => {
    if (!isPageLoad || !publishedApp || !deps.appPageViews) return;
    const forwardedIp = fromAppHost ? req.headers["x-qm-client-ip"] : undefined;
    const ip = typeof forwardedIp === "string" && forwardedIp ? forwardedIp : (req.socket.remoteAddress ?? null);
    const userAgent = req.headers["user-agent"];
    void deps.appPageViews
      .record({
        deploymentId: publishedApp.id,
        version: publishedApp.appliedVersion ?? publishedApp.currentVersion ?? null,
        viewer: sub ?? null,
        authMode,
        at: Date.now(),
        path: safePathname,
        ip,
        userAgent: typeof userAgent === "string" ? userAgent : null,
      })
      .catch(reportFailureAs("app page view log", undefined, publishedApp.id));
  };
  if (ctx.method === "GET" && ((!bareApp && isTopDocument) || isShellRequest) && canManage && loginUrl) {
    const annotationsEnabled =
      !!sub && (await deps.featureFlags?.enabled("app_annotations", scopeId("personal", sub))) === true;
    if (signInAttempted) {
      cleanUrlRedirect();
      return true;
    }
    if (isShellRequest) {
      if (pathname === "/__claw__/version" && publishedApp) {
        const [draft, grantees] = await Promise.all([
          app.appLiveEdit(publishedApp.id).then((edit) => edit?.draft),
          app.appGrantees(publishedApp.id),
        ]);
        const orgName = (deps.config?.getBranding(orgScope(deps)) ?? deps.brandingDefault)?.orgName;
        const { ownerScopeId } = publishedApp;
        sendJson(res, 200, {
          version: publishedApp.appliedVersion ?? publishedApp.currentVersion,
          ...(draft ? { live: draft.reloads } : {}),
          access: appAccess({ ownerScopeId, public: isPublic, grantees, viewer: sub!, orgName }),
        });
      } else if (
        annotationsEnabled &&
        (pathname === "/__claw__/annotate.js" || pathname === "/__claw__/annotate.css")
      ) {
        const kind = pathname.endsWith(".js") ? "js" : "css";
        res.writeHead(200, {
          "content-type": kind === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        });
        res.end(appAnnotationAsset(kind));
      } else sendJson(res, 404, { error: "not_found" });
      return true;
    }
    recordPageView("signed_in");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      appShellHtml({
        annotationsEnabled,
        slug,
        name: publishedApp?.displayName ?? slug,
        portalUrl: loginUrl,
        path: safePathname + url.search,
      }),
    );
    return true;
  }
  const viewer = sub ?? "";
  const reach =
    session?.appOnly && !isPublic && !authenticatedPermission
      ? { status: publishedApp ? ("denied" as const) : ("not_found" as const) }
      : await app.reachApp(
          publishedApp?.id ?? slug,
          viewer,
          canManage || isPublic || session?.appOnly ? { bypassAcl: true } : undefined,
        );
  if (reach.status === "denied") {
    const owner = (await app.getApp(slug).catch(swallowAs("apps: load app", null)))?.ownerScopeId;
    const ev = {
      at: Date.now(),
      principalId: viewer,
      action: "app.reach_denied",
      resource: slug,
      scopeLabel: owner ?? scopeId("personal", viewer),
      status: "denied",
    };
    const hour = Math.floor(ev.at / 3_600_000);
    if (deps.auditLog?.recordOnce)
      await deps.auditLog.recordOnce(tenantOf(ctx), `reach_denied|${viewer}|${slug}|${hour}`, ev);
    else deps.auditLog?.record(tenantOf(ctx), ev);
  }
  if (reach.status === "denied" && ctx.method === "POST" && pathname === REQUEST_ACCESS_PATH) {
    const d = await app.getApp(slug).catch(swallowAs("apps: load app", null));
    if (!d) {
      sendJson(res, 404, { error: "not_found" });
      return true;
    }
    const [ownerKind, ownerRef] = String(d.ownerScopeId).split(":", 2);
    const ownerId = ownerKind === "personal" && ownerRef ? ownerRef : d.createdBy;
    const label = d.displayName ?? d.name ?? slug;
    const day = Math.floor(Date.now() / 86_400_000);
    try {
      await app.enqueueDelivery({
        destination: {
          ...principalDestination(ownerId, viewer),
          deploymentAccess: { deploymentId: d.id, requesterId: viewer },
        },
        text:
          `${viewer} is asking for access to your app "${label}" (https://${rawHost}/). ` +
          `They signed in but the app isn't shared with them. To grant it, share the app with personal:${viewer}.`,
        idempotencyKey: `deploy-access-request:${slug}:${viewer}:${day}`,
      });
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 502, { error: "delivery_failed", message: "the request could not be delivered — try again later" });
    }
    return true;
  }
  if (reach.status === "denied" && wantsHtml) {
    res.writeHead(403, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(notSharedHtml(viewer));
    return true;
  }
  if (reach.status === "ok" && signInAttempted && ctx.method === "GET") {
    cleanUrlRedirect();
    return true;
  }
  if (reach.status === "ok") {
    let authMode: AppViewAuthMode = "public";
    if (session?.appOnly) authMode = "app_only";
    else if (sub && (canManage || authenticatedPermission)) authMode = "signed_in";
    recordPageView(authMode);
  }
  await proxyReach(ctx, reach, pathname, sub && (canManage || authenticatedPermission) ? sub : undefined, {
    frameAncestors: embedAncestors,
  });
  return true;
}

function gateCardHtml(title: string, paragraphsHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fafafa;
font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.card{max-width:420px;text-align:center;padding:32px 20px}h1{font-size:19px;margin:0 0 10px}
p{color:#a3a3a3;margin:0 0 8px}b{color:#fafafa}a{color:#fafafa}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${paragraphsHtml}</div></body></html>`;
}

const REQUEST_ACCESS_PATH = "/__claw__/request-access";

function notSharedHtml(sub: string): string {
  return gateCardHtml(
    "This app hasn't been shared with you",
    `<p>You're signed in as <b>${escapeHtml(sub)}</b>, but this app's owner hasn't shared it with you.</p>
<p>Ask the owner for access, or for the app's share link.</p>
<p><button id="req" style="margin-top:12px;padding:8px 18px;border-radius:8px;border:1px solid #3f3f3f;
background:#fafafa;color:#0a0a0a;font:inherit;font-weight:600;cursor:pointer">Request access</button></p>
<script>document.getElementById("req").addEventListener("click",async function(){
var b=this;b.disabled=true;b.textContent="Sending\u2026";
try{var r=await fetch(${JSON.stringify(REQUEST_ACCESS_PATH)},{method:"POST"});
b.textContent=r.ok?"Request sent \u2713":"Couldn't send \u2014 try again";b.disabled=r.ok;}
catch(e){b.textContent="Couldn't send \u2014 try again";b.disabled=false;}});</script>`,
  );
}

function signInFailedHtml(signIn: string): string {
  return gateCardHtml(
    "Sign-in didn't reach this app",
    `<p>You signed in, but this app never received your session. This usually means the app gateway is misconfigured — tell whoever runs it.</p>
<p><a href="${escapeHtml(signIn)}">Try signing in again</a></p>`,
  );
}

const appId = async (app: App, idOrName: string): Promise<string | undefined> => (await app.getApp(idOrName))?.id;

function gitServiceOf(tail: string, url: URL): "git-upload-pack" | "git-receive-pack" | null {
  if (tail === "git-upload-pack" || tail === "git-receive-pack") return tail;
  if (tail === "info/refs") {
    const s = url.searchParams.get("service");
    if (s === "git-upload-pack" || s === "git-receive-pack") return s;
  }
  return null;
}

function gitTokenFrom(ctx: BaseCtx): string | null {
  const authz = ctx.req.headers.authorization;
  if (typeof authz === "string") {
    const basic = /^basic\s+(.+)$/i.exec(authz);
    if (basic) {
      try {
        const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        const user = colon < 0 ? decoded : decoded.slice(0, colon);
        const pass = colon < 0 ? "" : decoded.slice(colon + 1);
        return pass || user || null;
      } catch {
        return null;
      }
    }
    const bearer = /^bearer\s+(.+)$/i.exec(authz);
    if (bearer) return bearer[1]!;
  }
  return ctx.url.searchParams.get("token") ?? ctx.url.searchParams.get("access_token");
}

function rejectGitAuth(res: BaseCtx["res"], message = "app git token required"): void {
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="app git"' });
  res.end(JSON.stringify({ error: "unauthorized", message }));
}

async function readRequestBytes(req: BaseCtx["req"]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function gitQueryString(url: URL): string {
  const qs = new URLSearchParams(url.searchParams);
  qs.delete("token");
  qs.delete("access_token");
  return qs.toString();
}

function headerEnd(buf: Buffer): { headEnd: number; bodyStart: number } | null {
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf >= 0) return { headEnd: crlf, bodyStart: crlf + 4 };
  const lf = buf.indexOf("\n\n");
  if (lf >= 0) return { headEnd: lf, bodyStart: lf + 2 };
  return null;
}

async function runGitHttpBackend(input: {
  repoPath: string;
  tail: string;
  method: string;
  query: string;
  contentType?: string;
  body: Buffer;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const repoRoot = dirname(input.repoPath);
  const repoName = basename(input.repoPath);
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    GIT_PROJECT_ROOT: repoRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${repoName}/${input.tail}`,
    REQUEST_METHOD: input.method,
    QUERY_STRING: input.query,
    CONTENT_TYPE: input.contentType ?? "",
    CONTENT_LENGTH: String(input.body.length),
    REMOTE_USER: "deployment-git",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "http.receivepack=true", "http-backend"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const split = headerEnd(out);
      if ((code ?? 0) !== 0 || !split) {
        reject(new Error(`git http-backend exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, split.headEnd).toString("utf8").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") {
          status = Number(value.split(/\s+/)[0]) || 200;
        } else {
          headers[name] = value;
        }
      }
      resolve({ status, headers, body: out.subarray(split.bodyStart) });
    });
    child.stdin.end(input.body);
  });
}

async function serveAppGit(ctx: BaseCtx): Promise<void> {
  const parts = appGitParts(ctx.pathname);
  if (!parts) return sendJson(ctx.res, 404, { error: "not_found" });
  const service = gitServiceOf(parts.tail, ctx.url);
  if (!service) return sendJson(ctx.res, 403, { error: "forbidden", message: "unsupported app git service" });
  const isPush = service === "git-receive-pack";
  if (isPush && !ctx.secret)
    return sendJson(ctx.res, 503, { error: "unavailable", message: "app git push requires core signing" });
  let access: Awaited<ReturnType<typeof verifyDeployGitAccess>> = null;
  if (ctx.secret) {
    const token = gitTokenFrom(ctx);
    access = token ? await verifyDeployGitAccess(ctx.secret, token) : null;
    if (!access) return rejectGitAuth(ctx.res);
    if (access.deploymentId !== parts.id)
      return sendJson(ctx.res, 403, { error: "forbidden", message: "token is for a different app" });
    if (isPush && access.permission !== "write")
      return sendJson(ctx.res, 403, { error: "forbidden", message: "app git token is read-only" });
    if (
      access.principalId &&
      !(await ctx.app.authorizesAppGitAccess(parts.id, access.principalId, access.permission))
    ) {
      return sendJson(ctx.res, 403, { error: "forbidden", message: "app git access has been revoked" });
    }
    if (isPush && !access.principalId) {
      return sendJson(ctx.res, 403, { error: "forbidden", message: "app git write access has been revoked" });
    }
  }
  const repoPath = await ctx.app.appGitRepoPath(parts.id);
  if (!repoPath) return sendJson(ctx.res, 404, { error: "not_found" });
  try {
    const body = ctx.method === "POST" ? await readRequestBytes(ctx.req) : Buffer.alloc(0);
    const runBackend = () =>
      runGitHttpBackend({
        repoPath,
        tail: parts.tail,
        method: ctx.method,
        query: gitQueryString(ctx.url),
        contentType: typeof ctx.req.headers["content-type"] === "string" ? ctx.req.headers["content-type"] : undefined,
        body,
      });
    const result = isPush
      ? await ctx.app.runAppGitPush(parts.id, access?.principalId, async () => {
          if (access?.principalId && !(await ctx.app.authorizesAppGitAccess(parts.id, access.principalId, "write"))) {
            const body = Buffer.from(
              JSON.stringify({ error: "forbidden", message: "app git write access has been revoked" }),
            );
            return {
              result: {
                status: 403,
                headers: { "content-type": "application/json", "content-length": String(body.length) },
                body,
              },
              ok: false,
            };
          }
          const r = await runBackend();
          return { result: r, ok: r.status >= 200 && r.status < 300 };
        })
      : await runBackend();
    ctx.res.writeHead(result.status, result.headers);
    ctx.res.end(result.body);
  } catch (e) {
    console.error("[deploy-git] request failed:", errMessage(e));
    return sendJson(ctx.res, 500, { error: "git_failed", message: "app git request failed" });
  }
}

function gitUrlBase(ctx: ApiCtx): string {
  if (ctx.deps.apiBaseUrl) {
    return ctx.deps.apiBaseUrl;
  } else if (ctx.deps.publicUrl) {
    return ctx.deps.publicUrl;
  } else {
    const host = (ctx.req.headers["x-forwarded-host"] as string) ?? ctx.req.headers.host ?? "localhost";
    const proto = (ctx.req.headers["x-forwarded-proto"] as string) ?? "http";
    return `${proto}://${host}`;
  }
}

async function appGitUrl(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "a git URL requires an agent capability token" });
  if (!ctx.secret) return sendJson(res, 503, { error: "unavailable", message: "core signing secret not configured" });
  const result = await app.appGitUrlFor(params.id!, capability, {
    secret: ctx.secret,
    baseUrl: gitUrlBase(ctx),
  });
  if (!result) return sendJson(res, 403, { error: "forbidden", message: "no access to this app" });
  return sendJson(res, 200, result);
}

async function createPublishedApp(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  if (!isDeployInput(body)) return sendJson(res, 400, { error: "bad_request", message: "expected a DeployInput" });
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  if (principalId && body.createdBy !== principalId) return sendJson(res, 403, { error: "forbidden" });
  try {
    return sendJson(res, 200, { app: appView(await app.deploy(body)) });
  } catch (e) {
    return sendJson(res, 400, { error: "deploy_failed", message: errMessage(e) });
  }
}

async function listApps(ctx: ApiCtx): Promise<void> {
  const { res, app, url, secret, capability, actor } = ctx;
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const viewer = capability ?? { actorId: principalId };
  const visible = await app.listAppsForViewer(tenantOf(ctx), viewer);
  const baseUrl = gitUrlBase(ctx);
  const ownerOf = (d: { ownerScopeId?: string }) =>
    d.ownerScopeId?.startsWith("personal:") ? d.ownerScopeId.slice("personal:".length) : undefined;
  const names = await createPersonNames({ users: ctx.deps.users, directory: ctx.deps.directory }).labels(
    visible.flatMap((d) => [ownerOf(d), d.createdBy].filter((id): id is string => !!id)),
  );
  const publishedApps = await Promise.all(
    visible.map(async (d) => {
      const owner = ownerOf(d);
      const named = {
        ...d,
        ...(owner ? { ownerName: names.get(owner)! } : {}),
        ...(d.createdBy ? { createdByName: names.get(d.createdBy)! } : {}),
      };
      if (!secret) return named;
      const git = await app.appGitUrlFor(d.id, viewer, { secret, baseUrl });
      return git ? { ...named, gitUrl: git.url } : named;
    }),
  );
  return sendJson(res, 200, { apps: publishedApps });
}

function textContentType(contentType: string): boolean {
  return (
    /^text\//i.test(contentType) ||
    /(?:^|\/)(?:json|xml|javascript)(?:;|$)/i.test(contentType) ||
    /\+(?:json|xml)(?:;|$)/i.test(contentType)
  );
}

const LOGS_DEFAULT_TAIL_LINES = 200;
const LOGS_MAX_TAIL_LINES = 2000;

async function appLogs(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability, actor, url } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const rawTail = url.searchParams.get("tailLines");
  const tailLines = rawTail === null ? LOGS_DEFAULT_TAIL_LINES : Number(rawTail);
  if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > LOGS_MAX_TAIL_LINES) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `tailLines must be an integer from 1 to ${LOGS_MAX_TAIL_LINES}`,
    });
  }
  const result = await app.appLogsFor(params.id!, viewer, { tailLines });
  if (result.status !== "ok") return sendJson(res, 404, { error: "not_found" });
  if (result.logs === null) return sendJson(res, 200, { logs: null, message: "no logs available for this app" });
  return sendJson(res, 200, { logs: result.logs });
}

async function fetchApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability, actor, url } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const path = normalizedAppFetchPath(url.searchParams.get("path"));
  if (!path) return sendJson(res, 400, { error: "bad_request", message: "path must be a safe absolute path" });
  const rawMaxBytes = url.searchParams.get("maxBytes");
  const maxBytes = rawMaxBytes === null ? AGENT_FETCH_DEFAULT_MAX_BYTES : Number(rawMaxBytes);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > AGENT_FETCH_MAX_BYTES) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `maxBytes must be an integer from 1 to ${AGENT_FETCH_MAX_BYTES}`,
    });
  }
  const reach = await app.reachApp(params.id!, viewer);
  if (reach.status !== "ok") return sendJson(res, 404, { error: "not_found" });
  try {
    const response = await fetchAppResponse(reach, path, maxBytes);
    const rawContentType = response.headers["content-type"];
    const contentType = typeof rawContentType === "string" ? rawContentType : "application/octet-stream";
    if (textContentType(contentType)) {
      return sendJson(res, 200, {
        status: response.status,
        contentType,
        body: response.body.toString("utf8"),
        truncated: response.truncated,
      });
    }
    return sendJson(res, 200, {
      status: response.status,
      contentType,
      body: response.body.toString("base64"),
      encoding: "base64",
      truncated: response.truncated,
    });
  } catch {
    return sendJson(res, 502, { error: "upstream_unreachable" });
  }
}

export async function getApp(ctx: ApiCtx): Promise<void> {
  const { res, app, url, secret, capability, actor, params } = ctx;
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const stored = await app.getApp(params.id!);
  const viewer = capability ?? { actorId: principalId };
  const permission = stored ? await app.appGitPermissionFor(stored.id, viewer) : null;
  if (!stored || !permission) return sendJson(res, 404, { error: "not_found" });
  const draft = permission === "write" ? (await app.appLiveEdit(stored.id))?.draft : null;
  const webUrl = app.appUrl(stored);
  const publishedApp = {
    ...appView(stored),
    permission,
    ...(webUrl ? { webUrl } : {}),
    ...(draft
      ? {
          savedEdits: {
            savedAt: draft.savedAt,
            ...(draft.publishAt ? { publishAt: draft.publishAt } : {}),
            ...(draft.failure ? { publishFailure: draft.failure } : {}),
          },
        }
      : {}),
  };
  if (!secret) return sendJson(res, 200, { app: publishedApp });
  const git = await app.appGitUrlFor(publishedApp.id, viewer, { secret, baseUrl: gitUrlBase(ctx) });
  return sendJson(res, 200, { app: git ? { ...publishedApp, gitUrl: git.url } : publishedApp });
}

async function rollbackApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id))) return sendJson(res, 403, { error: "forbidden" });
  const b = body as { version?: unknown };
  if (typeof b.version !== "number")
    return sendJson(res, 400, { error: "bad_request", message: "version (number) required" });
  try {
    await app.rollbackApp(id, b.version, ctx.capability?.actorId ?? ctx.actor?.p);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { error: "rollback_failed", message: errMessage(e) });
  }
}

async function redeployApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id))) return sendJson(res, 403, { error: "forbidden" });
  if (!isRedeployInput(body)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message:
        "entrypoint (string) and files (array) required; env must be a string map, homeFiles an array, alwaysOn a boolean",
    });
  }
  try {
    const actor = ctx.capability?.actorId ?? ctx.actor?.p;
    const input = actor ? { ...body, actor } : body;
    return sendJson(res, 200, { app: appView(await app.redeploy(id, input)) });
  } catch (e) {
    return sendJson(res, 400, { error: "deploy_failed", message: errMessage(e) });
  }
}

async function callerMayManageApp(ctx: ApiCtx, id: string): Promise<boolean> {
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  return principalId
    ? ctx.app.canManageApp(id, ctx.capability ?? { actorId: principalId }, ctx.capability?.scopeId)
    : false;
}

export async function archiveApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can archive it" });
  try {
    await app.archiveApp(id);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { error: "archive_failed", message: errMessage(e) });
  }
}

export async function restoreApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can restore it" });
  try {
    return sendJson(res, 200, {
      app: {
        ...appView(await app.restoreApp(id, capability?.actorId ?? ctx.actor?.p)),
        permission: "write",
      },
    });
  } catch (e) {
    return sendJson(res, 400, { error: "restore_failed", message: errMessage(e) });
  }
}

export async function renameApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can rename it" });
  const b = body as { name?: unknown };
  if (typeof b.name !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "name (string) required" });
  try {
    return sendJson(res, 200, { app: await app.renameApp(id, b.name) });
  } catch (e) {
    return sendJson(res, 400, { error: "rename_failed", message: errMessage(e) });
  }
}

export async function setAppDisplayName(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can rename it" });
  const b = body as { displayName?: unknown };
  if (typeof b.displayName !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "displayName (string) required" });
  try {
    return sendJson(res, 200, { app: await app.setAppDisplayName(id, b.displayName) });
  } catch (e) {
    return sendJson(res, 400, { error: "display_name_failed", message: errMessage(e) });
  }
}

async function setAppEmbedAncestors(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can change this" });
  const ancestors = parseEmbedAncestors((body as { embedAncestors?: unknown }).embedAncestors);
  if (!ancestors)
    return sendJson(res, 400, { error: "bad_request", message: `embedAncestors (${EMBED_ANCESTORS_HINT}) required` });
  try {
    return sendJson(res, 200, { app: appView(await app.setAppEmbedAncestors(id, ancestors)) });
  } catch (e) {
    return sendJson(res, 400, { error: "embed_ancestors_failed", message: errMessage(e) });
  }
}

async function setAppAlwaysOn(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await appId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageApp(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can change this" });
  const b = body as { alwaysOn?: unknown };
  if (typeof b.alwaysOn !== "boolean")
    return sendJson(res, 400, { error: "bad_request", message: "alwaysOn (boolean) required" });
  try {
    return sendJson(res, 200, { app: appView(await app.setAppAlwaysOn(id, b.alwaysOn)) });
  } catch (e) {
    return sendJson(res, 400, { error: "always_on_failed", message: errMessage(e) });
  }
}

const VISIBLE_APPS_PRINCIPAL = "app-export";

async function visibleAppsExport(ctx: BaseCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  if (!exportTokenAccepted(ctx, deps.spendExportToken)) return;
  const requested = url.searchParams.get("principalId")?.trim();
  if (!requested) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const principalId = canonicalPerson(requested);
  const live = (await app.listApps()).filter((d) => d.status !== "archived");
  const permissions = await app.appGitPermissionsFor(tenantOf(ctx), live, { actorId: principalId });
  const visible = live.flatMap((publishedApp, i) => {
    const permission = permissions[i];
    return permission ? [{ publishedApp, view: appView(publishedApp), permission }] : [];
  });
  const viewed =
    (await deps.appPageViews?.lastViews(
      tenantOf(ctx),
      principalId,
      visible.map(({ view }) => view.id),
    )) ?? new Map<string, number>();
  const publishedApps = visible.map(({ publishedApp, view: d, permission }) => ({
    id: d.id,
    ...(d.name ? { name: d.name } : {}),
    ...(d.displayName ? { displayName: d.displayName } : {}),
    url: app.appUrl(publishedApp) ?? null,
    createdBy: d.createdBy,
    owned: d.ownerScopeId === personalScope(principalId),
    permission,
    ...(d.updatedAt !== undefined ? { updatedAt: d.updatedAt } : {}),
    ...(d.lastAccessAt !== undefined ? { lastAccessAt: d.lastAccessAt } : {}),
    ...(viewed.has(d.id) ? { viewedAt: viewed.get(d.id) } : {}),
  }));
  audit(ctx, {
    principalId: VISIBLE_APPS_PRINCIPAL,
    action: "app.export",
    resource: principalId,
    scopeLabel: orgScope(deps),
    detail: `apps=${publishedApps.length}`,
  });
  sendJson(res, 200, { principalId, apps: publishedApps });
}

export const appRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/apps/export", auth: "public", handle: visibleAppsExport },
  { match: isAppGitRoute, auth: "public", tenant: appGitTenant, handle: serveAppGit },
  {
    match: (m, p) =>
      p.startsWith("/v1/admin/apps/") &&
      p.includes("/proxy") &&
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(m),
    auth: "source",
    handle: proxyAdminApp,
  },
  { match: (_m, p) => p.startsWith("/d/"), auth: "source", tenant: appPathTenant, handle: proxyApp },
];

export const appRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/apps", actor: "body.createdBy", auth: "source", handle: createPublishedApp },
  {
    method: "GET",
    path: "/v1/apps",
    browser: true,
    actor: "query.principalId",
    auth: "either",
    handle: listApps,
  },
  {
    method: "GET",
    path: "/v1/apps/:id",
    browser: true,
    actor: "query.principalId",
    auth: "either",
    handle: getApp,
  },
  { method: "GET", path: "/v1/apps/:id/fetch", auth: "either", handle: fetchApp },
  { method: "GET", path: "/v1/apps/:id/logs", auth: "either", handle: appLogs },
  { method: "GET", path: "/v1/apps/:id/git-url", auth: "either", handle: appGitUrl },
  { method: "POST", path: "/v1/apps/:id/rollback", auth: "source", handle: rollbackApp },
  { method: "POST", path: "/v1/apps/:id/redeploy", auth: "source", handle: redeployApp },
  {
    method: "POST",
    path: "/v1/apps/:id/archive",
    browser: true,
    actor: "person",
    auth: "either",
    handle: archiveApp,
  },
  {
    method: "POST",
    path: "/v1/apps/:id/restore",
    browser: true,
    actor: "person",
    auth: "either",
    handle: restoreApp,
  },
  {
    method: "POST",
    path: "/v1/apps/:id/name",
    browser: true,
    actor: "person",
    auth: "either",
    handle: renameApp,
  },
  {
    method: "POST",
    path: "/v1/apps/:id/display-name",
    browser: true,
    actor: "person",
    auth: "either",
    handle: setAppDisplayName,
  },
  { method: "POST", path: "/v1/apps/:id/always-on", auth: "either", handle: setAppAlwaysOn },
  {
    method: "POST",
    path: "/v1/apps/:id/embed-ancestors",
    browser: true,
    actor: "person",
    auth: "either",
    handle: setAppEmbedAncestors,
  },
];
