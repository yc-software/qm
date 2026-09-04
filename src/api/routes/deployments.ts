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
import { deploymentView, type App, type DeployInput } from "../app.ts";
import { errMessage } from "../../util/errors.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { canonicalPayload, escapeHtml, sendJson, verifyOrReject } from "../http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../auth/portal-identity.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { parseScopeId, scopeId, type Permission } from "../../types.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { resolveShareTarget as resolveShareTargetGrammar } from "../artifact-share.ts";
import { mintDeployOwnerToken, verifyDeployGitAccess, verifyDeployOwnerToken } from "../../deploy/access-token.ts";
import { APP_SHELL_PATH_PREFIX, appShellHtml } from "../../deploy/app-shell.ts";
import { principalDestination } from "../../reach/reach.ts";
import { portalSessionSub } from "../../deploy/viewer-session.ts";
import { proxyHeaders } from "../../util/http-proxy.ts";

function isDeployInput(b: unknown): b is DeployInput {
  return (
    isObj(b) &&
    typeof b.ownerScopeId === "string" &&
    typeof b.createdBy === "string" &&
    typeof b.entrypoint === "string" &&
    Array.isArray(b.files)
  );
}

async function proxyDeployment(ctx: BaseCtx): Promise<void> {
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
  const reach = await app.reachDeployment(id, principal);
  return proxyReach(ctx, reach, subPath);
}

function adminDeploymentProxyParts(pathname: string): { id: string; subPath: string } | null {
  const prefix = "/v1/admin/deployments/";
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

async function proxyAdminDeployment(ctx: BaseCtx): Promise<void> {
  const { req, res, app, deps, secret, auth, url, pathname, method } = ctx;
  const parts = adminDeploymentProxyParts(pathname);
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
  const deployment = (await app.listDeployments()).find((d) => d.id === parts.id);
  const actor = await authorizeAdmin({ req, res, deps, capability: null }, deployment?.ownerScopeId ?? orgScope(deps));
  if (!actor) return;
  if (!deployment) return sendJson(res, 404, { error: "not_found" });
  audit(deps, {
    principalId: actor.id,
    action: "deployment.visit",
    resource: deployment.id,
    scopeLabel: deployment.ownerScopeId,
  });
  const reach = await app.reachDeployment(parts.id, "", { bypassAcl: true });
  return proxyReach(ctx, reach, parts.subPath);
}

const GATEWAY_AUTH_HEADERS = [
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
interface DeploymentHttp2Connection {
  session: ClientHttp2Session;
  activeStreams: number;
  idleTimer?: NodeJS.Timeout;
  retiring?: boolean;
}
const deploymentHttp2Sessions = new Map<string, DeploymentHttp2Connection>();

function forwardableHeaders(req: BaseCtx["req"]): Record<string, string | string[]> {
  const out = proxyHeaders(req.headers, ["host", ...GATEWAY_AUTH_HEADERS]);
  const kept = String(out.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^(?:dpl_access|dpl_owner|portal_session)\s*=/.test(part));
  if (kept.length) out.cookie = kept.join("; ");
  else delete out.cookie;
  return out;
}

function gatewaySafeResponseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
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
    const kept = values.filter((cookie) => !/^\s*(?:dpl_access|dpl_owner|portal_session)\s*=/i.test(cookie));
    if (kept.length) out["set-cookie"] = kept;
    else delete out["set-cookie"];
  }
  return out;
}

function deploymentHttp2Session(origin: string): DeploymentHttp2Connection {
  const existing = deploymentHttp2Sessions.get(origin);
  if (existing && !existing.session.closed && !existing.session.destroyed) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return existing;
  }
  const session = connectHttp2(origin);
  session.unref();
  const connection: DeploymentHttp2Connection = { session, activeStreams: 0 };
  deploymentHttp2Sessions.set(origin, connection);
  const remove = (): void => {
    if (deploymentHttp2Sessions.get(origin) === connection) deploymentHttp2Sessions.delete(origin);
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = undefined;
  };
  session.on("error", () => {
    remove();
    session.destroy();
  });
  session.on("close", remove);
  session.on("goaway", () => retireDeploymentHttp2Connection(origin, connection));
  return connection;
}

function retireDeploymentHttp2Connection(origin: string, connection: DeploymentHttp2Connection): void {
  if (deploymentHttp2Sessions.get(origin) === connection) deploymentHttp2Sessions.delete(origin);
  if (connection.retiring || connection.session.destroyed) return;
  connection.retiring = true;
  connection.session.close();
  const timer = setTimeout(() => connection.session.destroy(), HTTP2_DRAIN_TIMEOUT_MS);
  timer.unref();
  connection.session.once("close", () => clearTimeout(timer));
}

function releaseDeploymentHttp2Stream(origin: string, connection: DeploymentHttp2Connection): void {
  connection.activeStreams--;
  if (connection.activeStreams !== 0 || deploymentHttp2Sessions.get(origin) !== connection) return;
  connection.idleTimer = setTimeout(() => connection.session.close(), HTTP2_IDLE_TIMEOUT_MS);
  connection.idleTimer.unref();
}

function checkDeploymentHttp2Session(connection: DeploymentHttp2Connection): void {
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
  endpoint: Awaited<ReturnType<App["reachDeployment"]>> & { status: "ok" },
  subPath: string,
  headers: Record<string, string | string[]>,
  bufferedBody: Buffer | null,
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
    const connection = deploymentHttp2Session(origin);
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
      if (sessionFailed) retireDeploymentHttp2Connection(origin, connection);
      if (replaySafe && !retried && sessionFailed && !res.headersSent && !res.destroyed && !res.writableEnded)
        return start(true);
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, 502, { error: "bad_gateway", message: "deployment unreachable" });
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
      if (sessionFailed) retireDeploymentHttp2Connection(origin, connection);
      const moved = deploymentHttp2Sessions.get(origin) !== connection;
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
      else if (!res.headersSent) sendJson(res, 502, { error: "bad_gateway", message: "deployment unreachable" });
      else res.destroy();
    };
    up.once("close", () => {
      releaseDeploymentHttp2Stream(origin, connection);
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
        else if (!res.headersSent)
          sendJson(res, 504, { error: "gateway_timeout", message: "deployment did not respond" });
        else res.end();
        up.close(http2Constants.NGHTTP2_CANCEL);
        checkDeploymentHttp2Session(connection);
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
      const safeHeaders = gatewaySafeResponseHeaders(responseHeaders);
      res.writeHead(status, safeHeaders);
      up.pipe(res, { end: false });
    });
    up.on("error", fail);
    if (replaySafe) up.end();
    else if (bufferedBody !== null) up.end(bufferedBody);
    else req.pipe(up);
  };
  start(false);
}

// --- cold-start warming page -------------------------------------------------
// AWS microVMs auto-resume on first connect, which can take many seconds. During
// that window a browser navigation would otherwise hang for the full dial timeout
// and then land on raw gateway JSON. For document requests we instead answer
// quickly with a small self-refreshing "warming up" page.
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
// -----------------------------------------------------------------------------

async function proxyReach(
  ctx: BaseCtx,
  reach: Awaited<ReturnType<App["reachDeployment"]>>,
  subPath: string,
): Promise<void> {
  const { req, res, deps, url, method } = ctx;
  if (res.destroyed) return;
  if (reach.status === "not_found") return sendJson(res, 404, { error: "not_found" });
  if (reach.status === "denied")
    return sendJson(res, 403, { error: "forbidden", message: "not in the deployment's scope" });
  const { host, port } = reach.endpoint;
  const upstreamKey = `${host}:${port}`;
  const shieldedUntil = throttledUpstreams.get(upstreamKey) ?? 0;
  if (Date.now() < shieldedUntil) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(Math.max(1, Math.ceil((shieldedUntil - Date.now()) / 1000))),
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ error: "throttled", message: "deployment is rate limited upstream" }));
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
    proxyReachHttp2(ctx, reach, subPath, headers, bufferedBody);
    return;
  }
  const htmlNav = wantsWarmingPage(req, method);
  const up = requestFn({ hostname: host, port, path: subPath + url.search, method, headers }, (upRes) => {
    up.setTimeout(0);
    markUpstreamUp(upstreamKey);
    upRes.on("error", () => res.destroy());
    armThrottleShield(upstreamKey, upRes.statusCode ?? 0, upRes);
    const headers = gatewaySafeResponseHeaders(upRes.headers);
    res.writeHead(upRes.statusCode ?? 502, headers);
    upRes.pipe(res);
  });
  const dialMs = warmingDialTimeoutMs(
    upstreamKey,
    htmlNav,
    deps.deployDialTimeoutMs ?? CONFIG_DEFAULTS.deployDialTimeoutMs,
  );
  up.setTimeout(dialMs, () => {
    if (htmlNav && !res.headersSent) sendWarmingPage(res);
    else if (!res.headersSent) sendJson(res, 504, { error: "gateway_timeout", message: "deployment did not respond" });
    else res.end();
    up.destroy();
  });
  up.on("error", () => {
    if (htmlNav && !res.headersSent) sendWarmingPage(res);
    else if (!res.headersSent) sendJson(res, 502, { error: "bad_gateway", message: "deployment unreachable" });
    else res.end();
  });
  req.on("error", () => up.destroy());
  if (bufferedBody !== null) up.end(bufferedBody);
  else req.pipe(up);
  return;
}

interface DeploymentFetchResult {
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

function deploymentFetchHttp1(
  endpoint: Awaited<ReturnType<App["reachDeployment"]>> & { status: "ok" },
  path: string,
  maxBytes: number,
  deadline: number,
): Promise<DeploymentFetchResult> {
  return new Promise((resolve, reject) => {
    const { host, port, tls, proxyHeaders } = endpoint.endpoint;
    const requestFn = tls ? httpsRequest : httpRequest;
    const request = requestFn(
      { hostname: host, port, path, method: "GET", headers: { ...proxyHeaders, "accept-encoding": "identity" } },
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

function deploymentFetchHttp2(
  endpoint: Awaited<ReturnType<App["reachDeployment"]>> & { status: "ok" },
  path: string,
  maxBytes: number,
  deadline: number,
): Promise<DeploymentFetchResult> {
  return new Promise((resolve, reject) => {
    const { host, port, tls, proxyHeaders } = endpoint.endpoint;
    const origin = `${tls ? "https" : "http"}://${host}:${port}`;
    const connection = deploymentHttp2Session(origin);
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
    stream.once("close", () => releaseDeploymentHttp2Stream(origin, connection));
    stream.end();
  });
}

function normalizedDeploymentFetchPath(raw: string | null): string | null {
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
  endpoint: Awaited<ReturnType<App["reachDeployment"]>> & { status: "ok" },
  location: string | string[] | number | undefined,
  currentPath: string,
): string | null {
  if (typeof location !== "string") return null;
  try {
    const { host, port, tls } = endpoint.endpoint;
    const origin = `${tls ? "https" : "http"}://${host}:${port}`;
    const next = new URL(location, `${origin}${currentPath}`);
    if (next.origin !== origin) return null;
    return normalizedDeploymentFetchPath(next.pathname + next.search);
  } catch {
    return null;
  }
}

async function fetchDeploymentResponse(
  endpoint: Awaited<ReturnType<App["reachDeployment"]>> & { status: "ok" },
  initialPath: string,
  maxBytes: number,
): Promise<DeploymentFetchResult> {
  let path = initialPath;
  const deadline = Date.now() + AGENT_FETCH_TIMEOUT_MS;
  for (let redirects = 0; ; redirects++) {
    const response =
      endpoint.endpoint.httpVersion === "2"
        ? await deploymentFetchHttp2(endpoint, path, maxBytes, deadline)
        : await deploymentFetchHttp1(endpoint, path, maxBytes, deadline);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= AGENT_FETCH_MAX_REDIRECTS) throw new Error("too many redirects");
    const next = redirectPath(endpoint, response.headers.location, path);
    if (!next) throw new Error("redirect leaves deployment");
    path = next;
  }
}

function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  }
  return "";
}

export async function proxyDeploymentSubdomain(ctx: BaseCtx): Promise<boolean> {
  const { req, res, app, deps, url, pathname } = ctx;
  const appsDomain = deps.deployAppsDomain;
  const gateSecret = deps.deployGateSecret;
  if (!appsDomain || !gateSecret) return false;
  const rawHost = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  if (!rawHost || !rawHost.endsWith(suffix)) return false;
  const slug = rawHost.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  const safePathname =
    pathname.startsWith("/") && !pathname.startsWith("//") && !/[\\\x00-\x1f]/.test(pathname) ? pathname : "/";
  const staleAccess = url.searchParams.has("access");
  url.searchParams.delete("access");
  const fromOwnerQuery = url.searchParams.get("owner") ?? "";
  url.searchParams.delete("owner");
  const signInAttempted = url.searchParams.get("dpl_signin") === "1";
  url.searchParams.delete("dpl_signin");
  const cleanUrlRedirect = (): void => {
    const qs = url.searchParams.toString();
    res.writeHead(302, { location: safePathname + (qs ? `?${qs}` : ""), "cache-control": "no-store" });
    res.end();
  };
  let ownerCookie: string | null = null;
  if (fromOwnerQuery) {
    const session = await verifyDeployOwnerToken(gateSecret, fromOwnerQuery, slug);
    if (session && (await app.canManageDeployment(slug, session.sub))) {
      const maxAge = Math.max(1, Math.floor((session.exp - Date.now()) / 1000));
      ownerCookie = `dpl_owner=${fromOwnerQuery}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    }
  }
  if (ownerCookie) {
    const qs = url.searchParams.toString();
    res.writeHead(302, {
      "set-cookie": [ownerCookie],
      location: safePathname + (qs ? `?${qs}` : ""),
    });
    res.end();
    return true;
  }
  if (staleAccess && ctx.method === "GET" && !cookieValue(req.headers.cookie, "dpl_owner")) {
    cleanUrlRedirect();
    return true;
  }
  let ownerSub: string | null = null;
  const ownerCookieValue = cookieValue(req.headers.cookie, "dpl_owner");
  if (ownerCookieValue) {
    const session = await verifyDeployOwnerToken(gateSecret, ownerCookieValue, slug);
    if (session && (await app.canManageDeployment(slug, session.sub))) ownerSub = session.sub;
  }
  if (ownerSub && ctx.method === "GET" && pathname.startsWith(APP_SHELL_PATH_PREFIX)) {
    if (pathname === "/__claw__/version") {
      const d = await app.getDeployment(slug);
      if (!d) sendJson(res, 404, { error: "not_found" });
      else sendJson(res, 200, { version: d.appliedVersion ?? d.currentVersion });
      return true;
    }
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  if (ownerSub) {
    if (signInAttempted && ctx.method === "GET") {
      cleanUrlRedirect();
      return true;
    }
    // A top-level document load gets the owner shell: a slim top bar over the app
    // (framed same-origin) with a slide-out chat column for iterating on it. The
    // frame's own load carries sec-fetch-dest: iframe, so it proxies straight through.
    const isTopDocument = String(req.headers["sec-fetch-dest"] ?? "") === "document";
    if (ctx.method === "GET" && isTopDocument && deps.deployAppsLoginUrl) {
      const accent = (await resolveBranding(deps.config, orgScope(deps), deps.brandingDefault)).accent;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        appShellHtml({
          slug,
          portalUrl: deps.deployAppsLoginUrl,
          path: safePathname + url.search,
          ...(accent ? { accent } : {}),
        }),
      );
      return true;
    }
    const reach = await app.reachDeployment(slug, "", { bypassAcl: true });
    await proxyReach(ctx, reach, pathname);
    return true;
  }
  const sessionSecret = deps.deployAppsSessionSecret;
  const loginUrl = deps.deployAppsLoginUrl;
  const wantsHtml = ctx.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
  const sub = sessionSecret ? portalSessionSub(req.headers.cookie, sessionSecret) : null;
  if (!sessionSecret || !loginUrl) {
    sendJson(res, 503, { error: "unavailable", message: "sign-in is not configured for deployment subdomains" });
    return true;
  }
  if (!sub) {
    const qs = url.searchParams.toString();
    const returnTo = `https://${rawHost}${safePathname}?${qs ? `${qs}&` : ""}dpl_signin=1`;
    const signIn = `${loginUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
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
  const reach = await app.reachDeployment(slug, sub);
  if (reach.status === "denied") {
    const owner = (await app.getDeployment(slug).catch(() => null))?.ownerScopeId;
    const ev = {
      at: Date.now(),
      principalId: sub,
      action: "deployment.reach_denied",
      resource: slug,
      scopeLabel: owner ?? scopeId("personal", sub),
      status: "denied",
    };
    const hour = Math.floor(ev.at / 3_600_000);
    if (deps.auditLog?.recordOnce) await deps.auditLog.recordOnce(`reach_denied|${sub}|${slug}|${hour}`, ev);
    else deps.auditLog?.record(ev);
  }
  if (reach.status === "denied" && ctx.method === "POST" && pathname === REQUEST_ACCESS_PATH) {
    const d = await app.getDeployment(slug).catch(() => null);
    if (!d) {
      sendJson(res, 404, { error: "not_found" });
      return true;
    }
    // The recipient is the app's owner: the personal home scope if it has one, else whoever created it.
    const [ownerKind, ownerRef] = String(d.ownerScopeId).split(":", 2);
    const ownerId = ownerKind === "personal" && ownerRef ? ownerRef : d.createdBy;
    const label = d.displayName ?? d.name ?? slug;
    // One request per visitor per app per day — the idempotent outbox absorbs button mashing.
    const day = Math.floor(Date.now() / 86_400_000);
    try {
      await app.enqueueDelivery({
        destination: principalDestination(ownerId, sub),
        text:
          `${sub} is asking for access to your app "${label}" (https://${rawHost}/). ` +
          `They signed in but the app isn't shared with them. To grant it, share the deployment with personal:${sub}.`,
        idempotencyKey: `deploy-access-request:${slug}:${sub}:${day}`,
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
    res.end(notSharedHtml(sub));
    return true;
  }
  if (reach.status === "ok" && signInAttempted && ctx.method === "GET") {
    cleanUrlRedirect();
    return true;
  }
  await proxyReach(ctx, reach, pathname);
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

const deploymentId = async (app: App, idOrName: string): Promise<string | undefined> =>
  (await app.listDeployments()).find((d) => d.id === idOrName || d.name === idOrName)?.id;

function deploymentGitParts(pathname: string): { id: string; tail: string } | null {
  const prefix = "/v1/deployments/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const marker = "/git/";
  const markerAt = rest.indexOf(marker);
  if (markerAt < 0) return null;
  const tail = rest.slice(markerAt + marker.length);
  if (!tail) return null;
  try {
    return { id: decodeURIComponent(rest.slice(0, markerAt)), tail };
  } catch {
    return null;
  }
}

function isDeploymentGitRoute(method: string, pathname: string): boolean {
  const parts = deploymentGitParts(pathname);
  if (!parts) return false;
  return (
    (method === "GET" && parts.tail === "info/refs") ||
    (method === "POST" && (parts.tail === "git-upload-pack" || parts.tail === "git-receive-pack"))
  );
}

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

function rejectGitAuth(res: BaseCtx["res"], message = "deployment git token required"): void {
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="deployment git"' });
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

async function serveDeploymentGit(ctx: BaseCtx): Promise<void> {
  const parts = deploymentGitParts(ctx.pathname);
  if (!parts) return sendJson(ctx.res, 404, { error: "not_found" });
  const service = gitServiceOf(parts.tail, ctx.url);
  if (!service) return sendJson(ctx.res, 403, { error: "forbidden", message: "unsupported deployment git service" });
  const isPush = service === "git-receive-pack";
  if (isPush && !ctx.secret)
    return sendJson(ctx.res, 503, { error: "unavailable", message: "deployment git push requires core signing" });
  let access: Awaited<ReturnType<typeof verifyDeployGitAccess>> = null;
  if (ctx.secret) {
    const token = gitTokenFrom(ctx);
    access = token ? await verifyDeployGitAccess(ctx.secret, token) : null;
    if (!access) return rejectGitAuth(ctx.res);
    if (access.deploymentId !== parts.id)
      return sendJson(ctx.res, 403, { error: "forbidden", message: "token is for a different deployment" });
    if (isPush && access.permission !== "write")
      return sendJson(ctx.res, 403, { error: "forbidden", message: "deployment git token is read-only" });
    if (
      access.principalId &&
      !(await ctx.app.authorizesDeploymentGitAccess(parts.id, access.principalId, access.permission))
    ) {
      return sendJson(ctx.res, 403, { error: "forbidden", message: "deployment git access has been revoked" });
    }
    if (isPush && !access.principalId) {
      return sendJson(ctx.res, 403, { error: "forbidden", message: "deployment git write access has been revoked" });
    }
  }
  const repoPath = await ctx.app.deploymentGitRepoPath(parts.id);
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
      ? await ctx.app.runDeploymentGitPush(parts.id, async () => {
          if (
            access?.principalId &&
            !(await ctx.app.authorizesDeploymentGitAccess(parts.id, access.principalId, "write"))
          ) {
            const body = Buffer.from(
              JSON.stringify({ error: "forbidden", message: "deployment git write access has been revoked" }),
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
    return sendJson(ctx.res, 500, { error: "git_failed", message: "deployment git request failed" });
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

async function deploymentGitUrl(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "a git URL requires an agent capability token" });
  if (!ctx.secret) return sendJson(res, 503, { error: "unavailable", message: "core signing secret not configured" });
  const result = await app.deploymentGitUrlFor(params.id!, capability.actorId, {
    secret: ctx.secret,
    baseUrl: gitUrlBase(ctx),
  });
  if (!result) return sendJson(res, 403, { error: "forbidden", message: "no access to this deployment" });
  return sendJson(res, 200, result);
}

const OWNER_LINK_TTL_MS = 5 * 60 * 1000;

async function deploymentOwnerUrl(ctx: ApiCtx): Promise<void> {
  const { res, app, params, deps } = ctx;
  const sub = ctx.capability?.actorId ?? ctx.actor?.p ?? ctx.url.searchParams.get("principalId");
  if (!sub) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });
  const gateSecret = deps.deployGateSecret;
  const appsDomain = deps.deployAppsDomain;
  if (!gateSecret || !appsDomain)
    return sendJson(res, 503, { error: "unavailable", message: "deployment subdomains are not configured" });
  const deployment = await app.getDeployment(params.id!);
  if (!deployment) return sendJson(res, 404, { error: "not_found" });
  const slug = deployment.name ?? deployment.id;
  if (!(await app.canManageDeployment(deployment.id, sub, ctx.capability?.scopeId)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can edit it live" });
  const exp = Date.now() + OWNER_LINK_TTL_MS;
  const token = await mintDeployOwnerToken(gateSecret, { slug, sub, exp });
  return sendJson(res, 200, { url: `https://${slug}.${appsDomain}/?owner=${token}`, expiresAt: exp });
}

async function createDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  if (!isDeployInput(body)) return sendJson(res, 400, { error: "bad_request", message: "expected a DeployInput" });
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  if (principalId && body.createdBy !== principalId) return sendJson(res, 403, { error: "forbidden" });
  try {
    return sendJson(res, 200, { deployment: await app.deploy(body) });
  } catch (e) {
    return sendJson(res, 400, { error: "deploy_failed", message: errMessage(e) });
  }
}

async function listDeployments(ctx: ApiCtx): Promise<void> {
  const { res, app, url, secret, capability, actor } = ctx;
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 200, { deployments: (await app.listDeployments()).map(deploymentView) });
  const visible = await app.listDeploymentsForViewer(principalId);
  const baseUrl = gitUrlBase(ctx);
  const deployments = await Promise.all(
    visible.map(async (d) => {
      if (!secret) return d;
      const git = await app.deploymentGitUrlFor(d.id, principalId, { secret, baseUrl });
      return git ? { ...d, gitUrl: git.url } : d;
    }),
  );
  return sendJson(res, 200, { deployments });
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

async function deploymentLogs(ctx: ApiCtx): Promise<void> {
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
  const result = await app.deploymentLogsFor(params.id!, viewer, { tailLines });
  if (result.status !== "ok") return sendJson(res, 404, { error: "not_found" });
  if (result.logs === null) return sendJson(res, 200, { logs: null, message: "no logs available for this deployment" });
  return sendJson(res, 200, { logs: result.logs });
}

async function fetchDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability, actor, url } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const path = normalizedDeploymentFetchPath(url.searchParams.get("path"));
  if (!path) return sendJson(res, 400, { error: "bad_request", message: "path must be a safe absolute path" });
  const rawMaxBytes = url.searchParams.get("maxBytes");
  const maxBytes = rawMaxBytes === null ? AGENT_FETCH_DEFAULT_MAX_BYTES : Number(rawMaxBytes);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > AGENT_FETCH_MAX_BYTES) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `maxBytes must be an integer from 1 to ${AGENT_FETCH_MAX_BYTES}`,
    });
  }
  const reach = await app.reachDeployment(params.id!, viewer);
  if (reach.status !== "ok") return sendJson(res, 404, { error: "not_found" });
  try {
    const response = await fetchDeploymentResponse(reach, path, maxBytes);
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

export async function getDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, url, secret, capability, params } = ctx;
  const principalId = capability ? capability.actorId : url.searchParams.get("principalId");
  const id = params.id!;
  let deployment;
  if (principalId) {
    deployment = (await app.listDeploymentsForViewer(principalId)).find((d) => d.id === id || d.name === id);
  } else {
    const stored = (await app.listDeployments()).find((d) => d.id === id || d.name === id);
    deployment = stored ? deploymentView(stored) : undefined;
  }
  if (!deployment) return sendJson(res, 404, { error: "not_found" });
  if (!principalId || !secret) return sendJson(res, 200, { deployment });
  const git = await app.deploymentGitUrlFor(deployment.id, principalId, { secret, baseUrl: gitUrlBase(ctx) });
  return sendJson(res, 200, { deployment: git ? { ...deployment, gitUrl: git.url } : deployment });
}

async function rollbackDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await deploymentId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageDeployment(ctx, id))) return sendJson(res, 403, { error: "forbidden" });
  const b = body as { version?: unknown };
  if (typeof b.version !== "number")
    return sendJson(res, 400, { error: "bad_request", message: "version (number) required" });
  try {
    await app.rollbackDeployment(id, b.version);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { error: "rollback_failed", message: errMessage(e) });
  }
}

async function redeployDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await deploymentId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageDeployment(ctx, id))) return sendJson(res, 403, { error: "forbidden" });
  const b = body as { entrypoint?: unknown; files?: unknown };
  if (typeof b.entrypoint !== "string" || !Array.isArray(b.files)) {
    return sendJson(res, 400, { error: "bad_request", message: "entrypoint (string) and files (array) required" });
  }
  try {
    return sendJson(res, 200, { deployment: await app.redeploy(id, { entrypoint: b.entrypoint, files: b.files }) });
  } catch (e) {
    return sendJson(res, 400, { error: "deploy_failed", message: errMessage(e) });
  }
}

async function callerMayManageDeployment(ctx: ApiCtx, id: string): Promise<boolean> {
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  return !principalId || ctx.app.canManageDeployment(id, principalId, ctx.capability?.scopeId);
}

export async function archiveDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  const id = await deploymentId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageDeployment(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can archive it" });
  try {
    await app.archiveDeployment(id);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { error: "archive_failed", message: errMessage(e) });
  }
}

export async function restoreDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability, body } = ctx;
  const id = await deploymentId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageDeployment(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can restore it" });
  try {
    const principalId =
      capability?.actorId ??
      ctx.actor?.p ??
      (isObj(body) && typeof body.principalId === "string" ? body.principalId : undefined);
    return sendJson(res, 200, {
      deployment: { ...deploymentView(await app.restoreDeployment(id, principalId)), permission: "write" },
    });
  } catch (e) {
    return sendJson(res, 400, { error: "restore_failed", message: errMessage(e) });
  }
}

export async function renameDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await deploymentId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageDeployment(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can rename it" });
  const b = body as { name?: unknown };
  if (typeof b.name !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "name (string) required" });
  try {
    return sendJson(res, 200, { deployment: await app.renameDeployment(id, b.name) });
  } catch (e) {
    return sendJson(res, 400, { error: "rename_failed", message: errMessage(e) });
  }
}

export async function setDeploymentDisplayName(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = await deploymentId(app, params.id!);
  if (!id) return sendJson(res, 404, { error: "not_found" });
  if (!(await callerMayManageDeployment(ctx, id)))
    return sendJson(res, 403, { error: "forbidden", message: "only someone who manages this app can rename it" });
  const b = body as { displayName?: unknown };
  if (typeof b.displayName !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "displayName (string) required" });
  try {
    return sendJson(res, 200, { deployment: await app.setDeploymentDisplayName(id, b.displayName) });
  } catch (e) {
    return sendJson(res, 400, { error: "display_name_failed", message: errMessage(e) });
  }
}

type ShareTarget =
  | { kind: "ok"; scope: string; label: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ principalId: string; displayName: string }> }
  | { kind: "invalid"; message: string };

export function resolveShareTarget(app: App, input: { scope?: string; recipient?: string }): Promise<ShareTarget> {
  return resolveShareTargetGrammar(app, input, {
    invalidScope: (scope) => `invalid scope "${scope}" — use "org" or a scope id like personal:<id> or org:<id>`,
    targetRequired: 'a target is required: pass `scope` ("org" or a scope id) or `recipient` (a teammate\'s name)',
  });
}

export async function shareDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "sharing requires an agent capability token" });
  const b = (isObj(body) ? body : {}) as { scope?: unknown; recipient?: unknown; access?: unknown };
  const access = typeof b.access === "string" ? b.access.toLowerCase() : "view";
  if (access !== "view" && access !== "manage" && access !== "none") {
    return sendJson(res, 400, { error: "bad_request", message: 'access must be "view", "manage", or "none"' });
  }
  let permission: Permission | null = "read";
  if (access === "none") permission = null;
  else if (access === "manage") permission = "write";
  const target = await resolveShareTarget(app, {
    ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
    ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
  });
  if (target.kind === "invalid") return sendJson(res, 400, { error: "bad_request", message: target.message });
  if (target.kind === "none")
    return sendJson(res, 404, {
      error: "recipient_not_found",
      message: `no teammate matches "${String(b.recipient)}"`,
    });
  if (target.kind === "ambiguous")
    return sendJson(res, 409, {
      error: "ambiguous_recipient",
      message: "more than one teammate matches",
      candidates: target.candidates,
    });
  try {
    const grantees = await app.shareDeployment(params.id!, target.scope, permission, { createdBy: capability.actorId });
    const orgGrant = grantees.find((g) => parseScopeId(g.scope).kind === "org");
    let reach = "owner-only";
    if (orgGrant) reach = `everyone in ${parseScopeId(orgGrant.scope).ref}`;
    else if (grantees.length) reach = `${grantees.length} grantee${grantees.length === 1 ? "" : "s"}`;
    return sendJson(res, 200, {
      ok: true,
      target: { scope: target.scope, label: target.label },
      access,
      reach,
      grantees,
    });
  } catch (e) {
    const msg = errMessage(e);
    let status = 400;
    if (/no such app/.test(msg)) status = 404;
    else if (/only the owner/.test(msg)) status = 403;
    let error = "share_failed";
    if (status === 404) error = "not_found";
    else if (status === 403) error = "forbidden";
    return sendJson(res, status, { error, message: msg });
  }
}

export const deploymentRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { match: isDeploymentGitRoute, auth: "public", handle: serveDeploymentGit },
  {
    match: (m, p) =>
      p.startsWith("/v1/admin/deployments/") &&
      p.includes("/proxy") &&
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(m),
    auth: "source",
    handle: proxyAdminDeployment,
  },
  { match: (_m, p) => p.startsWith("/d/"), auth: "source", handle: proxyDeployment },
];

export const deploymentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/deployments", auth: "source", handle: createDeployment },
  { method: "GET", path: "/v1/deployments", auth: "either", handle: listDeployments },
  { method: "GET", path: "/v1/deployments/:id", auth: "either", handle: getDeployment },
  { method: "GET", path: "/v1/deployments/:id/fetch", auth: "either", handle: fetchDeployment },
  { method: "GET", path: "/v1/deployments/:id/logs", auth: "either", handle: deploymentLogs },
  { method: "GET", path: "/v1/deployments/:id/git-url", auth: "either", handle: deploymentGitUrl },
  { method: "GET", path: "/v1/deployments/:id/owner-url", auth: "source", handle: deploymentOwnerUrl },
  { method: "POST", path: "/v1/deployments/:id/share", auth: "either", handle: shareDeployment },
  { method: "POST", path: "/v1/deployments/:id/rollback", auth: "source", handle: rollbackDeployment },
  { method: "POST", path: "/v1/deployments/:id/redeploy", auth: "source", handle: redeployDeployment },
  { method: "POST", path: "/v1/deployments/:id/archive", auth: "either", handle: archiveDeployment },
  { method: "POST", path: "/v1/deployments/:id/restore", auth: "either", handle: restoreDeployment },
  { method: "POST", path: "/v1/deployments/:id/name", auth: "either", handle: renameDeployment },
  { method: "POST", path: "/v1/deployments/:id/display-name", auth: "either", handle: setDeploymentDisplayName },
];
