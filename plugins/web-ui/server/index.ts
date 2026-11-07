import "./instrument.ts";
import { handleVoiceRoute, sweepDictationSpool } from "./voice-routes.ts";
import { browserErrorConfig } from "../../chassis/src/browser-error-config.ts";
import { analyticsHookConfig } from "../../chassis/src/analytics-config.ts";
import { reportBackendError, withRequestContext } from "../../chassis/src/error-reporting.ts";
import { errChain } from "../../chassis/src/errors.ts";
import { composioCallbackUrl } from "./composio-return.ts";
import { sharedSessionHtml } from "./shared-session.ts";
import { uiCanvasRoutes } from "./ui-canvas-routes.ts";
import { adminRoutes } from "./admin-routes.ts";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, posix } from "node:path";
import { randomBytes } from "node:crypto";
import {
  fetchCoreText,
  relayCoreStream,
  signedHeaders,
  withSourceAuthNonce,
  CAPABILITY_HEADER,
  relayCoreDownload,
  type HttpMethod,
} from "../../chassis/src/core-client.ts";
import { findRoute } from "../../chassis/src/router.ts";
import {
  json,
  gzipAccepted,
  readBody as readBodyCapped,
  cookie,
  PayloadTooLargeError,
  relayStream,
  sendBuffered,
  serveFavicon,
} from "../../chassis/src/http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { createBrandingCache, injectBranding } from "../../chassis/src/branding.ts";
import { parseSuggestedActivities } from "../../chassis/src/suggested-activities.ts";
import { listedPrincipals, principalInAllowlist, principalListed } from "../../chassis/src/principal-allowlist.ts";

import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
} from "../../chassis/src/env.ts";

const suggestedActivities = parseSuggestedActivities(process.env.WEB_UI_SUGGESTED_ACTIVITIES);
const PUBLIC_URL = (process.env.PUBLIC_WEB_URL ?? "http://localhost:8096").replace(/\/$/, "");
const WEB_UI_DEV = process.env.WEB_UI_DEV === "1";
const ALLOW_UNSIGNED_TEST_IDENTITY =
  process.env.NODE_ENV === "test" && process.env.ALLOW_UNSIGNED_TEST_IDENTITY === "1";
const COOKIE_AUTH = !CORE_SIGNING_SECRET || ALLOW_UNSIGNED_TEST_IDENTITY;
const AUTH_MODE = COOKIE_AUTH ? "dev" : "portal";
const ALLOW = listedPrincipals(process.env.WEB_UI_PRINCIPALS);
export function isInboxUser(principalId: string, configuredUsers = process.env.INBOX_USERS): boolean {
  return principalInAllowlist(principalId, configuredUsers);
}

export function isLoopsUser(principalId: string, configuredUsers = process.env.LOOPS_USERS): boolean {
  return principalListed(principalId, configuredUsers);
}

async function hasInboxLoopPreview(user: string): Promise<boolean> {
  try {
    const response = await coreFetch("GET", `/v1/inbox/access?principalId=${encodeURIComponent(user)}`, "", 2_000);
    return response.status === 200 && JSON.parse(response.text).enabled === true;
  } catch {
    return false;
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const brandingCache = createBrandingCache(async () => {
  const r = await coreFetch("GET", "/v1/surface-config", "", 2_000);
  if (r.status !== 200) throw new Error(`surface-config ${r.status}`);
  const b = (JSON.parse(r.text) as { branding?: Record<string, unknown> }).branding;
  return {
    ...(typeof b?.orgName === "string" ? { orgName: b.orgName } : {}),
    ...(typeof b?.accent === "string" ? { accent: b.accent } : {}),
    ...(typeof b?.mark === "string" ? { mark: b.mark } : {}),
    ...(typeof b?.markUrl === "string" ? { markUrl: b.markUrl } : {}),
    ...(typeof b?.selfLabel === "string" ? { selfLabel: b.selfLabel } : {}),
  };
});

async function serveWebManifest(res: ServerResponse): Promise<void> {
  const branding = await brandingCache.forRender();
  const name = branding.selfLabel || "QM";
  const manifest = {
    name,
    short_name: name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: process.env.WEB_UI_FAVICON_SVG ? "/favicon.svg" : "/brand-mark.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ],
  };
  res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" });
  res.end(JSON.stringify(manifest));
}

async function brandIndexHtml(html: string): Promise<string> {
  const branding = await brandingCache.forRender();
  return injectBranding(html, branding, { titleSuffix: "· Web" });
}

const portalTokenStore = new AsyncLocalStorage<string | undefined>();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const { scriptOrigins: analyticsScriptOrigins, connectOrigins: analyticsOrigins } = analyticsHookConfig(
  process.env.WEB_UI_ANALYTICS,
);
const browserErrors = browserErrorConfig(process.env);
const browserErrorOrigin = browserErrors ? new URL(browserErrors.dsn).origin : undefined;

const SPA_CSP = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval'${analyticsScriptOrigins.map((origin) => ` ${origin}`).join("")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${analyticsOrigins.map((origin) => ` ${origin}`).join("")}${browserErrorOrigin ? ` ${browserErrorOrigin}` : ""}`,
  "frame-src 'self' data: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  `form-action 'self'${process.env.QM_SLACK_SERVICE_URL ? ` ${new URL(process.env.QM_SLACK_SERVICE_URL).origin} https://slack.com` : ""}`,
  "object-src 'none'",
].join("; ");

function withSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "content-security-policy": SPA_CSP,
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "referrer-policy": process.env.QM_SLACK_SERVICE_URL ? "strict-origin" : "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  };
}

const APPS_FRAME_DOMAIN = (process.env.DEPLOY_APPS_DOMAIN ?? "").toLowerCase();

function framedByOwnSurfaces(
  res: ServerResponse,
  headers: Record<string, string>,
  csp: string,
): Record<string, string> {
  res.removeHeader("x-frame-options");
  const { "x-frame-options": _blanketDeny, ...rest } = headers;
  return { ...rest, "content-security-policy": csp };
}

interface ViteDevServer {
  middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
  transformIndexHtml(url: string, html: string): Promise<string>;
}

type CreateViteServer = (opts: Record<string, unknown>) => Promise<ViteDevServer>;

function relay(res: ServerResponse, r: { status: number; text: string }): void {
  sendBuffered(res, r.status, { "content-type": "application/json", "x-content-type-options": "nosniff" }, r.text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  sendBuffered(res, status, withSecurityHeaders({ "content-type": "text/html; charset=utf-8" }), html);
}

function mayManageDeployment(d: { permission?: unknown }): boolean {
  return d.permission === "write";
}

async function gateManageDeployment(res: ServerResponse, user: string, id: string): Promise<boolean> {
  const r = await coreFetch("GET", `/v1/deployments?principalId=${encodeURIComponent(user)}`);
  if (r.status !== 200) {
    relay(res, r);
    return false;
  }
  let list: Array<Record<string, unknown>>;
  try {
    list = (JSON.parse(r.text) as { deployments?: Array<Record<string, unknown>> }).deployments ?? [];
  } catch {
    json(res, 502, { error: "bad_core_response" });
    return false;
  }
  const d = list.find((x) => x.id === id || x.name === id);
  if (!d) {
    json(res, 404, { error: "not_found" });
    return false;
  }
  if (!mayManageDeployment(d)) {
    json(res, 403, { error: "forbidden", message: "you do not manage this deployment" });
    return false;
  }
  return true;
}

function callbackHtml(query: string): string {
  const safe = query.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../../../?${safe}"><title>Connector</title>`;
}

interface Identity {
  user: string;
  name: string | null;
  impersonator: string | null;
  portalVerified: boolean;
}
type Denial = "unauthenticated" | "not_allowed";

function authenticate(req: IncomingMessage): { identity: Identity } | { denied: Denial } {
  let user: string | null | undefined;
  let name: string | null | undefined;
  let impersonator: string | null | undefined;
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const claims =
    token && PORTAL_IDENTITY_SECRET ? verifyPortalIdentity(token, PORTAL_IDENTITY_SECRET, Date.now()) : null;
  if (claims) {
    user = claims.p;
    name = claims.n ?? null;
    impersonator = claims.imp ?? null;
  } else {
    if (!COOKIE_AUTH) return { denied: "unauthenticated" };
    user = cookie(req, "webuiuser");
    name = cookie(req, "webuiuser_name");
    impersonator = cookie(req, "webui_impersonator");
  }
  if (!user) return { denied: "unauthenticated" };
  if (ALLOW.length > 0 && !ALLOW.includes(user)) return { denied: "not_allowed" };
  return {
    identity: { user, name: name?.trim() || null, impersonator: impersonator ?? null, portalVerified: Boolean(claims) },
  };
}

function resolveIdentity(req: IncomingMessage): Identity | null {
  const outcome = authenticate(req);
  return "identity" in outcome ? outcome.identity : null;
}

function cookieUser(req: IncomingMessage): string | null {
  return resolveIdentity(req)?.user ?? null;
}

function unauthorized(res: ServerResponse, req: IncomingMessage): void {
  const outcome = authenticate(req);
  const denied = "denied" in outcome ? outcome.denied : "unauthenticated";
  return json(res, 401, { error: "sign in", mode: AUTH_MODE, reason: denied });
}

const SESSION_TTL_S = 90 * 24 * 60 * 60;
function sessionCookie(id: string): string {
  return `webuiuser=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

const MAX_BODY_BYTES = 1_000_000;
const readBody = (req: IncomingMessage): Promise<string> => readBodyCapped(req, MAX_BODY_BYTES);

async function coreFetch(
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
  timeoutMs?: number,
): Promise<{ status: number; text: string }> {
  const portalTok = portalTokenStore.getStore();
  return fetchCoreText({
    origin: CORE,
    secret: CORE_SIGNING_SECRET,
    method,
    path: pathWithQuery,
    body: rawBody,
    headers: portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
}

async function mintSessionCap(): Promise<{ token: string } | { status: number; text: string }> {
  const cap = await coreFetch("POST", "/v1/session-cap", "");
  if (cap.status !== 200) return { status: cap.status === 401 ? 401 : 503, text: cap.text };
  let token: string | undefined;
  try {
    token = (JSON.parse(cap.text) as { token?: string }).token;
  } catch {
    token = undefined;
  }
  if (!token)
    return { status: 503, text: JSON.stringify({ error: "not_configured", message: "no session capability" }) };
  return { token };
}

async function relayCore(res: ServerResponse, method: HttpMethod, pathWithQuery: string, rawBody = ""): Promise<void> {
  const portalTok = portalTokenStore.getStore();
  return relayCoreStream(res, {
    origin: CORE,
    secret: CORE_SIGNING_SECRET,
    method,
    path: pathWithQuery,
    body: rawBody,
    headers: portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : undefined,
  });
}

async function relayCap(res: ServerResponse, method: HttpMethod, pathWithQuery: string, rawBody = ""): Promise<void> {
  const cap = await mintSessionCap();
  if (!("token" in cap)) return relay(res, cap);
  return relayCoreStream(res, {
    origin: CORE,
    method,
    path: pathWithQuery,
    body: rawBody,
    headers: { [CAPABILITY_HEADER]: cap.token },
  });
}

/**
 * Read and parse a JSON object body, or answer 400 and return null — a null
 * return always means the response has been sent. Only plain objects come
 * back (a body of `null`, `false`, or a bare string is a 400, never a falsy
 * value a caller could mistake for "already answered"). Routes that
 * historically tolerated an empty body keep that via allowEmpty; strict
 * routes (allowEmpty=false) refuse it, so e.g. a bare POST cannot read as
 * "clear the display name".
 */
async function readJson<T extends object>(
  req: IncomingMessage,
  res: ServerResponse,
  allowEmpty = true,
  maxBytes = MAX_BODY_BYTES,
): Promise<T | null> {
  try {
    const raw = await readBodyCapped(req, maxBytes);
    if (!raw && !allowEmpty) {
      json(res, 400, { error: "bad_request" });
      return null;
    }
    const parsed: unknown = JSON.parse(raw || "{}");
    if (typeof parsed !== "object" || parsed === null) {
      json(res, 400, { error: "bad_request" });
      return null;
    }
    return parsed as T;
  } catch (e) {
    if (e instanceof PayloadTooLargeError) throw e;
    json(res, 400, { error: "bad_request" });
    return null;
  }
}

interface CoreWebhook {
  id: string;
  ownerScopeId: string;
  owner: string;
  createdBy: string;
  action: string;
  verification: { scheme: string; secret?: string };
  filters?: Array<{ path: string; in: string[] }>;
  destination?: unknown;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  lastDeliveryId?: string;
  lastError?: string;
}

async function setWebhookEnabledViaCore(
  res: ServerResponse,
  user: string,
  id: string,
  verb: "disable" | "enable",
): Promise<void> {
  const r = await coreFetch("GET", `/v1/webhooks?viewer=${encodeURIComponent(user)}`);
  if (r.status < 200 || r.status >= 300) return relay(res, r);
  let webhooks: CoreWebhook[] = [];
  try {
    webhooks = (JSON.parse(r.text) as { webhooks?: CoreWebhook[] }).webhooks ?? [];
  } catch {
    void 0;
  }
  if (!webhooks.some((w) => w.id === id)) return json(res, 404, { error: "not_found" });
  return relayCore(
    res,
    "POST",
    `/v1/webhooks/${encodeURIComponent(id)}/${verb}?principalId=${encodeURIComponent(user)}`,
  );
}

interface CoreCron {
  id: string;
  ownerScopeId: string;
  owner: string;
  createdBy: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  destination?: unknown;
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
  permission?: "read" | "manage";
}

function uploadFileName(url: URL): string {
  return url.searchParams.get("name")?.trim() || "file";
}

async function stageUploadStream(req: IncomingMessage, sha256: string): Promise<Response> {
  const corePath = withSourceAuthNonce("/v1/blobs", CORE_SIGNING_SECRET);
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, "POST", corePath, "", sha256),
    "content-type": "application/octet-stream",
    "x-content-sha256": sha256,
  };
  return fetch(`${CORE}${corePath}`, {
    method: "POST",
    headers,
    body: req as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function declaredSha(url: URL): string {
  return url.searchParams.get("sha") ?? "";
}

async function uploadBlobFromRequest(req: IncomingMessage, res: ServerResponse, sha256: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
  }
  const staged = await stageUploadStream(req, sha256);
  const headers = { "content-type": staged.headers.get("content-type") ?? "application/json" };
  return sendBuffered(res, staged.status, headers, await staged.text());
}

async function uploadFileFromRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sha256: string,
  name: string,
  register: { path: string; fields: Record<string, string>; headers?: Record<string, string> },
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
  }
  const staged = await stageUploadStream(req, sha256);
  const stagedText = await staged.text();
  if (!staged.ok) {
    const headers = { "content-type": staged.headers.get("content-type") ?? "application/json" };
    return sendBuffered(res, staged.status, headers, stagedText);
  }
  const stagedBody = JSON.parse(stagedText) as { blobId: string };
  const body = JSON.stringify({
    ...register.fields,
    name,
    mimetype:
      typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
    blobId: stagedBody.blobId,
  });
  const portalTok = portalTokenStore.getStore();
  const registered = await fetchCoreText({
    origin: CORE,
    secret: CORE_SIGNING_SECRET,
    method: "POST",
    path: register.path,
    body,
    headers: register.headers ?? (portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : undefined),
  });
  return sendBuffered(res, registered.status, { "content-type": "application/json" }, registered.text);
}

export interface WebReleases {
  document(name: string): Promise<string>;
  file(path: string, gzip: boolean): Promise<{ body: Readable; gzip: boolean } | null>;
}

let releases: WebReleases | undefined;

export function serveReleasesFrom(source: WebReleases): void {
  releases = source;
}

function liveReleases(): WebReleases {
  if (!releases) throw new Error("the web UI server was started without a release source");
  return releases;
}

function releaseUnavailable(res: ServerResponse, what: string, error: unknown): void {
  console.error(`[web-ui] ${what} unavailable: ${errChain(error)}`);
  reportBackendError(error);
  if (!res.headersSent) json(res, 503, { error: "web_ui_unavailable", message: "The web UI release is unavailable." });
  else res.destroy();
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = posix.normalize(decodeURIComponent(urlPath)).replace(/^\/+/, "");
  if (rel === ".." || rel.startsWith("../") || rel.includes("\\")) return void json(res, 403, { error: "forbidden" });
  if (!extname(rel) || rel === "index.html") {
    let html: string;
    try {
      html = await liveReleases().document("index.html");
    } catch (error) {
      return releaseUnavailable(res, "index.html", error);
    }
    const headers = withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return sendBuffered(res, 200, headers, await brandIndexHtml(html));
  }
  let found: Awaited<ReturnType<WebReleases["file"]>>;
  try {
    found = await liveReleases().file(rel, gzipAccepted(res.req));
  } catch (error) {
    return releaseUnavailable(res, rel, error);
  }
  if (!found) return void json(res, 404, { error: "not_found" });
  const headers = withSecurityHeaders({
    "content-type": CONTENT_TYPES[extname(rel)] ?? "application/octet-stream",
    "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    vary: "accept-encoding",
  });
  res.writeHead(200, found.gzip ? { ...headers, "content-encoding": "gzip" } : headers);
  relayStream(found.body, res, {
    onError: (error) => console.error(`[web-ui] streaming ${rel} failed: ${errChain(error)}`),
  });
}

async function serveAppEditHtml(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
  if (!APPS_FRAME_DOMAIN || !/^[a-z0-9-]{1,63}$/.test(slug)) return false;
  let html: string;
  if (vite) {
    const raw = readFileSync(join(ROOT, "index.html"), "utf8").replace("%BASE_URL%favicon.svg", "favicon.svg");
    html = await vite.transformIndexHtml(req.url ?? "/", raw);
  } else {
    try {
      html = await liveReleases().document("index.html");
    } catch (error) {
      releaseUnavailable(res, "index.html", error);
      return true;
    }
  }
  const headers = withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  const csp = SPA_CSP.replace("frame-ancestors 'self'", `frame-ancestors 'self' ${slug}.${APPS_FRAME_DOMAIN}`);
  sendBuffered(res, 200, framedByOwnSurfaces(res, headers, csp), await brandIndexHtml(html));
  return true;
}

let vite: ViteDevServer | undefined;

async function createVite(server: Server): Promise<ViteDevServer | undefined> {
  if (!WEB_UI_DEV) return undefined;
  const importVite = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{ createServer: CreateViteServer }>;
  const { createServer: createViteServer } = await importVite("vite");
  return createViteServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server },
    },
  });
}

async function serveVite(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!vite) return false;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      res.off("finish", finish);
      res.off("close", finish);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    res.once("finish", finish);
    res.once("close", finish);
    vite!.middlewares(req, res, (err?: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    });
  });
  if (res.headersSent || res.writableEnded) return true;
  if (extname(path)) return false;
  let html = readFileSync(join(ROOT, "index.html"), "utf8");
  html = html.replace("%BASE_URL%favicon.svg", "favicon.svg");
  html = await vite.transformIndexHtml(req.url ?? "/", html);
  sendHtml(res, 200, await brandIndexHtml(html));
  return true;
}

interface WebCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: string;
  params: Record<string, string>;
}

type WebRoute = { handle: (c: WebCtx) => unknown } & (
  { method: string; path: string } | { match: (method: string, pathname: string) => boolean }
);

async function serveInboxItemImage(c: WebCtx): Promise<unknown> {
  const { res, url } = c;
  const qs = new URLSearchParams({ principalId: c.user });
  const ctxParam = url.searchParams.get("ctx");
  const iParam = url.searchParams.get("i");
  if (ctxParam) qs.set("ctx", ctxParam);
  if (iParam) qs.set("i", iParam);
  const corePath = withSourceAuthNonce(
    `/v1/loops/${encodeURIComponent(c.params.id!)}/items/${encodeURIComponent(c.params.itemId!)}/image?${qs.toString()}`,
    CORE_SIGNING_SECRET,
  );
  const portalTok = portalTokenStore.getStore();
  const r = await fetch(`${CORE}${corePath}`, {
    headers: {
      ...signedHeaders(CORE_SIGNING_SECRET, "GET", corePath, ""),
      ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
    },
  });
  if (!r.ok || !r.body) {
    res.writeHead(r.status === 404 ? 404 : 502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: r.status === 404 ? "not_found" : "upstream_error" }));
  }
  const contentType = r.headers.get("content-type") ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType.startsWith("image/") ? contentType : "application/octet-stream",
    "cache-control": "private, max-age=3600",
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
  });
  return res.end(Buffer.from(await r.arrayBuffer()));
}

const apiRoutes: readonly WebRoute[] = [
  {
    method: "GET",
    path: "/api/composio/callback",
    handle: async (c) => {
      c.res.setHeader("Cache-Control", "no-store");
      c.res.setHeader("Referrer-Policy", "no-referrer");
      const result = await coreFetch(
        "POST",
        "/v1/composio/complete-auth",
        JSON.stringify({ sessionUri: c.url.searchParams.get("session_uri") }),
      );
      if (result.status !== 200) return relay(c.res, result);
      const data = JSON.parse(result.text) as { returnTo?: string | null };
      const base = new URL(PUBLIC_URL);
      const target = data.returnTo
        ? new URL(data.returnTo, base)
        : new URL("./?view=settings", `${PUBLIC_URL.replace(/\/$/, "")}/`);
      if (target.origin !== base.origin) return json(c.res, 400, { error: "invalid_return_url" });
      c.res.writeHead(303, { location: target.href });
      c.res.end();
    },
  },
  { method: "GET", path: "/api/composio/slack", handle: (c) => relayCore(c.res, "GET", "/v1/composio/slack") },
  {
    method: "POST",
    path: "/api/composio/slack/authorize",
    handle: async (c) => {
      const body = await readJson<{ returnTo?: unknown; state?: unknown }>(c.req, c.res, false);
      if (!body) return;
      const callback = composioCallbackUrl(PUBLIC_URL, body.returnTo, body.state);
      if (!callback) return json(c.res, 400, { error: "invalid_return_url" });
      const url = new URL(callback);
      url.searchParams.delete("composioReturn");
      url.searchParams.set("slackReturn", String(body.state));
      c.res.setHeader("Cache-Control", "no-store");
      return relayCore(c.res, "POST", "/v1/composio/slack/authorize", JSON.stringify({ callbackUrl: url.href }));
    },
  },
  {
    method: "GET",
    path: "/api/composio/toolkits",
    handle: async (c) =>
      relayCore(
        c.res,
        "GET",
        `/v1/composio/toolkits?${new URLSearchParams({ cursor: c.url.searchParams.get("cursor") ?? "" })}`,
      ),
  },
  {
    method: "GET",
    path: "/api/composio/connections",
    handle: async (c) => {
      c.res.setHeader("Cache-Control", "no-store");
      return relayCore(
        c.res,
        "GET",
        `/v1/composio/connections?${new URLSearchParams({ cursor: c.url.searchParams.get("cursor") ?? "" })}`,
      );
    },
  },
  {
    method: "POST",
    path: "/api/composio/authorize",
    handle: async (c) => {
      const body = await readJson<{ toolkit?: unknown; returnTo?: unknown; state?: unknown }>(c.req, c.res, false);
      if (!body) return;
      c.res.setHeader("Cache-Control", "no-store");
      const callbackUrl = composioCallbackUrl(PUBLIC_URL, body.returnTo, body.state);
      if (!callbackUrl && (body.returnTo !== undefined || body.state !== undefined)) {
        return json(c.res, 400, { error: "invalid_return_url" });
      }
      return relayCore(
        c.res,
        "POST",
        "/v1/composio/authorize",
        JSON.stringify({ toolkit: body.toolkit, ...(callbackUrl ? { callbackUrl } : {}) }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/blobs",
    handle: async (c) => {
      const { req, res, url } = c;
      return uploadBlobFromRequest(req, res, declaredSha(url));
    },
  },
  {
    method: "POST",
    path: "/api/files/upload",
    handle: async (c) => {
      const { req, res, url, user } = c;
      const scope = url.searchParams.get("scope");
      return uploadFileFromRequest(req, res, declaredSha(url), uploadFileName(url), {
        path: "/v1/files/upload",
        fields: { principalId: user, ...(scope ? { scopeId: scope } : {}) },
      });
    },
  },
  {
    method: "GET",
    path: "/api/contexts/:scope/ambient-policy",
    handle: async (c) => {
      const { res, user } = c;
      const scope = c.params.scope!;
      return relayCore(
        res,
        "GET",
        `/v1/contexts/policy?principalId=${encodeURIComponent(user)}&scope=${encodeURIComponent(scope)}`,
      );
    },
  },
  {
    method: "PUT",
    path: "/api/contexts/:scope/ambient-policy",
    handle: async (c) => {
      const { req, res, user } = c;
      const scope = c.params.scope!;
      const p = await readJson<{ orders?: unknown; bots?: unknown; ambientEnabled?: unknown; baseUpdatedAt?: unknown }>(
        req,
        res,
      );
      if (!p) return;
      return relayCore(
        res,
        "PUT",
        "/v1/contexts/policy",
        JSON.stringify({
          principalId: user,
          scope,
          orders: p.orders,
          bots: p.bots,
          ambientEnabled: p.ambientEnabled,
          baseUpdatedAt: p.baseUpdatedAt,
        }),
      );
    },
  },
  {
    method: "GET",
    path: "/api/directory/resolve",
    handle: async (c) => {
      const { res, url } = c;
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
      if (!q) return json(res, 400, { error: "bad_request", message: "q required" });
      return relayCore(res, "GET", `/v1/directory/resolve?q=${encodeURIComponent(q)}`);
    },
  },
  {
    method: "POST",
    path: "/api/suggested-activities",
    handle: async (c) => {
      const input = JSON.parse((await readBody(c.req)) || "{}") as {
        timezone?: unknown;
        poll?: unknown;
        refresh?: unknown;
      };
      const response = await coreFetch(
        "POST",
        "/v1/suggested-activities",
        JSON.stringify({
          principalId: c.user,
          seeds: suggestedActivities,
          timezone: input.timezone,
          poll: input.poll,
          refresh: input.refresh,
        }),
        60_000,
      );
      return json(c.res, response.status, JSON.parse(response.text));
    },
  },
  {
    method: "POST",
    path: "/api/suggested-activities/dismiss",
    handle: async (c) => {
      const input = JSON.parse((await readBody(c.req)) || "{}") as { id?: unknown };
      const response = await coreFetch(
        "POST",
        "/v1/suggested-activities/dismiss",
        JSON.stringify({ principalId: c.user, id: input.id }),
        15_000,
      );
      return json(c.res, response.status, JSON.parse(response.text));
    },
  },
  ...adminRoutes({
    origin: CORE,
    secret: CORE_SIGNING_SECRET,
    org: ORG,
    portalHeaders: (): Record<string, string> => {
      const token = portalTokenStore.getStore();
      return token ? { [PORTAL_IDENTITY_HEADER]: token } : {};
    },
    impersonated: (req) => Boolean(resolveIdentity(req)?.impersonator),
    readBody,
    uploadFile: uploadFileFromRequest,
    refreshBranding: () => brandingCache.refreshNow(),
    json,
  }),
  ...uiCanvasRoutes({
    impersonated: (req) => Boolean(resolveIdentity(req)?.impersonator),
    coreFetch,
    relayCore,
    relay,
    json,
    readJson,
  }),
  {
    method: "GET",
    path: "/api/inbox",
    handle: async (c) => {
      const { res, user } = c;
      const qs = new URLSearchParams({ principalId: user });
      for (const key of ["cursor", "loopId", "view", "itemId", "filter"]) {
        const value = c.url.searchParams.get(key);
        if (value) qs.set(key, value);
      }
      return relayCore(res, "GET", `/v1/inbox?${qs}`);
    },
  },
  {
    method: "POST",
    path: "/api/inbox/sent-chat",
    handle: async ({ req, res, user }) => {
      if (!isInboxUser(user)) return json(res, 403, { error: "forbidden" });
      res.setHeader("Cache-Control", "no-store");
      return relayCore(res, "POST", "/v1/loops/inbox/sent-chat", await readBody(req));
    },
  },
  {
    method: "POST",
    path: "/api/inbox/selection",
    handle: async (c) =>
      relayCore(c.res, "PUT", `/v1/inbox?principalId=${encodeURIComponent(c.user)}`, await readBody(c.req)),
  },
  {
    method: "POST",
    path: "/api/inbox/sync-cron",
    handle: async (c) => {
      const { req, res, user } = c;
      return relayCore(
        res,
        "POST",
        `/v1/loops/inbox/sync-cron?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      );
    },
  },
  {
    method: "GET",
    path: "/api/loops/:id/items",
    handle: async (c) => {
      const { res, user, url } = c;
      const qs = new URLSearchParams({ principalId: user });
      const state = url.searchParams.get("state");
      if (state) qs.set("state", state);
      return relayCore(res, "GET", `/v1/loops/${encodeURIComponent(c.params.id!)}/items?${qs.toString()}`);
    },
  },
  {
    method: "GET",
    path: "/api/loops/:id/items/:itemId",
    handle: async (c) => {
      const { res, user, params, url } = c;
      const qs = new URLSearchParams({ principalId: user });
      if (url.searchParams.get("refreshSource") === "1") qs.set("refreshSource", "1");
      return relayCore(
        res,
        "GET",
        `/v1/loops/${encodeURIComponent(params.id!)}/items/${encodeURIComponent(params.itemId!)}?${qs.toString()}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/loops/:id/items/:itemId/image",
    handle: serveInboxItemImage,
  },
  ...(["action", "followup"] as const).map((leaf): WebRoute => ({
    method: "POST",
    path: `/api/loops/:id/items/:itemId/${leaf}`,
    handle: async (c) => {
      const { req, res, user, params } = c;
      return relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(params.id!)}/items/${encodeURIComponent(params.itemId!)}/${leaf}?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      );
    },
  })),
  {
    method: "POST",
    path: "/api/connectors/:provider/start",
    handle: async (c) => {
      const { res, user } = c;
      const provider = c.params.provider!;
      const callback = `${PUBLIC_URL}/v1/connectors/oauth/${encodeURIComponent(provider)}/callback`;
      const body = await readJson<{ returnTo?: unknown }>(c.req, res);
      if (!body) return;
      const returnTo =
        typeof body?.returnTo === "string" &&
        body.returnTo.startsWith("/") &&
        !body.returnTo.startsWith("//") &&
        !body.returnTo.includes("\\") &&
        new URL(body.returnTo, PUBLIC_URL).origin === new URL(PUBLIC_URL).origin
          ? body.returnTo
          : "/keychain";
      const params = new URLSearchParams({ principalId: user, redirectUri: callback, returnTo });
      const corePath = `/v1/connectors/oauth/${encodeURIComponent(provider)}/start?${params.toString()}`;
      return relayCore(res, "GET", corePath);
    },
  },
  {
    method: "GET",
    path: "/api/keychain/overview",
    handle: async (c) => {
      const { res } = c;
      return relayCap(res, "GET", "/v1/keychain/overview");
    },
  },
  {
    method: "POST",
    path: "/api/keychain/grants/:id/revoke",
    handle: async (c) => {
      const { res } = c;
      const id = c.params.id!;
      return relayCap(res, "POST", `/v1/keychain/grants/${encodeURIComponent(id)}/revoke`, "{}");
    },
  },
  {
    method: "POST",
    path: "/api/keychain/drops",
    handle: async (c) => {
      const { req, res } = c;
      const p = await readJson<{ service?: unknown; purpose?: unknown; envKey?: unknown }>(req, res, false);
      if (!p) return;
      const draft = {
        ...(typeof p.service === "string" ? { service: p.service } : {}),
        ...(typeof p.purpose === "string" ? { purpose: p.purpose } : {}),
        ...(typeof p.envKey === "string" ? { envKey: p.envKey } : {}),
      };
      return relayCap(res, "POST", "/v1/keychain/drops", JSON.stringify(draft));
    },
  },
  {
    method: "DELETE",
    path: "/api/keychain/credentials/:id",
    handle: async (c) => {
      const { res } = c;
      const id = c.params.id!;
      if (!id) return json(res, 400, { error: "bad_request", message: "credential id required" });
      return relayCap(res, "DELETE", `/v1/keychain/credentials/${encodeURIComponent(id)}`);
    },
  },
  {
    method: "GET",
    path: "/api/deployments",
    handle: async (c) => {
      const { res, user } = c;
      const r = await coreFetch("GET", `/v1/deployments?principalId=${encodeURIComponent(user)}`);
      if (r.status !== 200) {
        return relay(res, r);
      }
      let deployments: Array<Record<string, unknown>>;
      try {
        const parsed = JSON.parse(r.text) as { deployments?: Array<Record<string, unknown>> };
        deployments = parsed.deployments ?? [];
      } catch {
        return json(res, 502, { error: "bad_core_response" });
      }
      return json(res, 200, {
        deployments: deployments.map((d) => ({ ...d, webUrl: `/deployments/${encodeURIComponent(String(d.id))}/` })),
      });
    },
  },
  {
    method: "GET",
    path: "/api/deployments/:id",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!id || id.includes("/")) return json(res, 404, { error: "not_found" });
      const r = await coreFetch(
        "GET",
        `/v1/deployments/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
      );
      if (r.status !== 200) return relay(res, r);
      try {
        const parsed = JSON.parse(r.text) as { deployment?: Record<string, unknown> };
        if (!parsed.deployment) return json(res, 502, { error: "bad_core_response" });
        return json(res, 200, {
          deployment: {
            ...parsed.deployment,
            webUrl: `/deployments/${encodeURIComponent(String(parsed.deployment.id))}/`,
          },
        });
      } catch {
        return json(res, 502, { error: "bad_core_response" });
      }
    },
  },
  {
    method: "GET",
    path: "/api/deployments/:id/share",
    handle: async ({ res, params }) => relayCap(res, "GET", `/v1/deployments/${encodeURIComponent(params.id!)}/share`),
  },
  {
    method: "POST",
    path: "/api/deployments/:id/share",
    handle: async ({ req, res, params }) => {
      const body = await readJson<{
        scope?: unknown;
        recipient?: unknown;
        email?: unknown;
        access?: unknown;
        public?: unknown;
      }>(req, res, false);
      if (!body) return;
      return relayCap(
        res,
        "POST",
        `/v1/deployments/${encodeURIComponent(params.id!)}/share`,
        JSON.stringify({
          scope: body.scope,
          recipient: body.recipient,
          email: body.email,
          access: body.access,
          public: body.public,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/display-name",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      const p = await readJson<{ displayName?: unknown }>(req, res, false);
      if (!p) return;
      const displayName = String(p.displayName ?? "");
      return relayCore(
        res,
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/display-name`,
        JSON.stringify({ displayName }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/name",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      const p = await readJson<{ name?: unknown }>(req, res, false);
      if (!p) return;
      const name = String(p.name ?? "");
      return relayCore(res, "POST", `/v1/deployments/${encodeURIComponent(id)}/name`, JSON.stringify({ name }));
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/embed-ancestors",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      const p = await readJson<{ embedAncestors?: unknown }>(req, res, false);
      if (!p) return;
      const embedAncestors = Array.isArray(p.embedAncestors) ? p.embedAncestors : [];
      return relayCore(
        res,
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/embed-ancestors`,
        JSON.stringify({ embedAncestors }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/archive",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      return relayCore(res, "POST", `/v1/deployments/${encodeURIComponent(id)}/archive`);
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/restore",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      return relayCore(
        res,
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/restore`,
        JSON.stringify({ principalId: user }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/withdraw",
    handle: (c) => relayCore(c.res, "POST", `/v1/runs/${encodeURIComponent(c.params.id!)}/withdraw`),
  },
  {
    method: "GET",
    path: "/api/inbox/sent/:messageId",
    handle: async ({ res, user, params, url }) => {
      if (!isInboxUser(user)) return json(res, 403, { error: "forbidden" });
      const query = new URLSearchParams();
      const accountType = url.searchParams.get("accountType");
      if (accountType) query.set("accountType", accountType);
      res.setHeader("Cache-Control", "no-store");
      return relayCore(
        res,
        "GET",
        `/v1/connectors/gmail/sent/${encodeURIComponent(params.messageId!)}${query.size ? `?${query}` : ""}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/inbox/sent",
    handle: async ({ res, user, url }) => {
      if (!isInboxUser(user)) return json(res, 403, { error: "forbidden" });
      const params = new URLSearchParams();
      for (const key of ["pageToken", "accountType"]) {
        const value = url.searchParams.get(key);
        if (value) params.set(key, value);
      }
      res.setHeader("Cache-Control", "no-store");
      return relayCore(res, "GET", `/v1/connectors/gmail/sent?${params}`);
    },
  },
  {
    method: "GET",
    path: "/api/loops",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(res, "GET", `/v1/loops?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "POST",
    path: "/api/loops",
    handle: async (c) => {
      const { req, res, user } = c;
      return relayCore(res, "POST", `/v1/loops?principalId=${encodeURIComponent(user)}`, await readBody(req));
    },
  },
  {
    method: "GET",
    path: "/api/loops/:id",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(
        res,
        "GET",
        `/v1/loops/${encodeURIComponent(c.params.id!)}?principalId=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "PATCH",
    path: "/api/loops/:id",
    handle: async (c) => {
      const { req, res, user } = c;
      return relayCore(
        res,
        "PATCH",
        `/v1/loops/${encodeURIComponent(c.params.id!)}?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/loops/:id",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(
        res,
        "DELETE",
        `/v1/loops/${encodeURIComponent(c.params.id!)}?principalId=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/loops/:id/ingestion",
    handle: async ({ res, user, params }) =>
      relayCore(
        res,
        "GET",
        `/v1/loops/${encodeURIComponent(params.id!)}/ingestion?principalId=${encodeURIComponent(user)}`,
      ),
  },
  {
    method: "POST",
    path: "/api/loops/:id/ingestion",
    handle: async ({ req, res, user, params }) =>
      relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(params.id!)}/ingestion?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      ),
  },
  {
    method: "PATCH",
    path: "/api/loops/:id/ingestion/:sourceId",
    handle: async ({ req, res, user, params }) =>
      relayCore(
        res,
        "PATCH",
        `/v1/loops/${encodeURIComponent(params.id!)}/ingestion/${encodeURIComponent(params.sourceId!)}?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      ),
  },
  {
    method: "POST",
    path: "/api/loops/:id/fire",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(c.params.id!)}/fire?principalId=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "POST",
    path: "/api/loops/:id/triage/preview",
    handle: async ({ req, res, user, params }) =>
      relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(params.id!)}/triage/preview?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      ),
  },
  {
    method: "POST",
    path: "/api/loops/:id/outputs/:outputId/decide",
    handle: async (c) => {
      const { req, res, user } = c;
      return relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(c.params.id!)}/outputs/${encodeURIComponent(c.params.outputId!)}/decide?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      );
    },
  },
  {
    method: "POST",
    path: "/api/loops/:id/grants",
    handle: async (c) => {
      const { req, res, user } = c;
      return relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(c.params.id!)}/grants?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      );
    },
  },
  {
    method: "POST",
    path: "/api/loops/:id/autopilot",
    handle: async (c) => {
      const { req, res, user } = c;
      return relayCore(
        res,
        "POST",
        `/v1/loops/${encodeURIComponent(c.params.id!)}/autopilot?principalId=${encodeURIComponent(user)}`,
        await readBody(req),
      );
    },
  },
  {
    method: "POST",
    path: "/api/webhooks",
    handle: async (c) => {
      const { req, res, user } = c;
      let action: string;
      let verification: { scheme: string; secret?: string } = { scheme: "hmac-sha256" };
      let filters: Array<{ path: string; in: string[] }> | undefined;
      try {
        const p = JSON.parse(await readBody(req)) as {
          action?: unknown;
          verification?: { scheme?: unknown; secret?: unknown };
          filters?: unknown;
          destination?: unknown;
        };
        action = String(p.action ?? "").trim();
        if (p.verification !== undefined) {
          if (
            typeof p.verification !== "object" ||
            p.verification === null ||
            typeof p.verification.scheme !== "string"
          ) {
            return json(res, 400, {
              error: "unsupported_verification",
              message: "verification requires a scheme",
            });
          }
          verification = {
            scheme: p.verification.scheme,
            ...(p.verification.secret ? { secret: String(p.verification.secret) } : {}),
          };
        }
        if (p.filters !== undefined) {
          if (
            !Array.isArray(p.filters) ||
            !p.filters.every((filter: unknown) => {
              if (!filter || typeof filter !== "object") return false;
              const candidate = filter as { path?: unknown; in?: unknown };
              return (
                typeof candidate.path === "string" &&
                candidate.path.trim().length > 0 &&
                Array.isArray(candidate.in) &&
                candidate.in.length > 0 &&
                candidate.in.every((value) => typeof value === "string" && value.trim().length > 0)
              );
            })
          )
            return json(res, 400, {
              error: "invalid_filters",
              message: "every filter requires a path and at least one value",
            });
          filters = p.filters as Array<{ path: string; in: string[] }>;
        }
        if (p.destination !== undefined) {
          return json(res, 400, {
            error: "invalid_destination",
            message: "choose webhook destinations with the agent so teammate and channel names can be resolved safely",
          });
        }
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request", message: "expected JSON body" });
      }
      if (!action)
        return json(res, 400, {
          error: "action_required",
          message: "an action (the agent's instructions) is required",
        });
      if (!verification.secret) {
        verification = { ...verification, secret: randomBytes(32).toString("hex") };
      }
      const reqBody = JSON.stringify({
        ownerScopeId: `personal:${user}`,
        owner: user,
        createdBy: user,
        action,
        verification,
        ...(filters ? { filters } : {}),
      });
      return relayCore(res, "POST", "/v1/webhooks", reqBody);
    },
  },
  {
    method: "POST",
    path: "/api/webhooks/:id/disable",
    handle: (c) => setWebhookEnabledViaCore(c.res, c.user, c.params.id!, "disable"),
  },
  {
    method: "POST",
    path: "/api/webhooks/:id/enable",
    handle: (c) => setWebhookEnabledViaCore(c.res, c.user, c.params.id!, "enable"),
  },
  {
    method: "GET",
    path: "/api/crons",
    handle: async (c) => {
      const { res, user } = c;
      const r = await coreFetch("GET", `/v1/crons?viewer=${encodeURIComponent(user)}`);
      if (r.status < 200 || r.status >= 300) {
        return relay(res, r);
      }
      let crons: CoreCron[] = [];
      let visible: CoreCron[] = [];
      try {
        const parsed = JSON.parse(r.text) as { crons?: CoreCron[]; visible?: CoreCron[] };
        crons = parsed.crons ?? [];
        visible = parsed.visible ?? [];
      } catch {
        void 0;
      }
      return json(res, 200, { crons, visible });
    },
  },
];

const routeRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && path === "/favicon.svg") {
    return serveFavicon(
      res,
      {
        svg: process.env.WEB_UI_FAVICON_SVG,
        emoji: process.env.WEB_UI_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F",
      },
      "no-cache",
    );
  }
  if (method === "GET" && path === "/manifest.webmanifest") return serveWebManifest(res);

  if (method === "POST" && path === "/signin") {
    if (!COOKIE_AUTH) return json(res, 404, { error: "not_found" });
    const body = await readBody(req);
    const id = (() => {
      try {
        return String(JSON.parse(body).user ?? "").trim();
      } catch {
        return "";
      }
    })();
    if (!id) return json(res, 400, { error: "bad_request", message: "Enter a principal to sign in as." });
    if (ALLOW.length > 0 && !ALLOW.includes(id))
      return json(res, 403, {
        error: "not_allowed",
        message: `${id.slice(0, 120)} isn't in this instance's allowed principals. Add it to WEB_UI_PRINCIPALS, or leave that unset to allow any principal.`,
      });
    res.writeHead(200, {
      "set-cookie": sessionCookie(id),
      "content-type": "application/json",
    });
    return res.end(JSON.stringify({ ok: true, user: id }));
  }

  if (method === "POST" && path === "/signout") {
    res.writeHead(200, { "set-cookie": "webuiuser=; HttpOnly; Path=/; Max-Age=0", "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (method === "GET" && path.startsWith("/connectors/oauth/") && path.endsWith("/callback")) {
    const provider = path.slice("/connectors/oauth/".length, -"/callback".length);
    const corePath = `/v1/connectors/oauth/${encodeURIComponent(provider)}/callback${url.search}`;
    let ok: boolean;
    try {
      const r = await fetch(`${CORE}${corePath}`, { redirect: "manual" });
      ok = r.status >= 200 && r.status < 300;
    } catch {
      ok = false;
    }
    const q = `view=keychain&connector=${encodeURIComponent(provider)}&status=${ok ? "connected" : "error"}`;
    return sendHtml(res, ok ? 200 : 400, callbackHtml(q));
  }

  if (method === "GET" && path.startsWith("/share/")) {
    const match = path.match(/^\/share\/(internal|external)\/([a-f0-9-]{36})(?:\/files\/([a-f0-9-]{36}))?$/);
    if (!match) return json(res, 404, { error: "not_found" });
    const external = match[1] === "external";
    const user = external ? null : cookieUser(req);
    if (!external && !user) return json(res, 401, { error: "sign in" });
    const corePath = `/v1/${external ? "public-shares" : "shared-sessions"}/${match[2]}${match[3] ? `/files/${match[3]}` : ""}?${external ? "" : `viewer=${encodeURIComponent(user!)}&`}inline=${url.searchParams.get("inline") === "1" ? "1" : "0"}`;
    if (match[3]) {
      const portalTok = external ? null : portalTokenStore.getStore();
      return relayCoreDownload(res, {
        origin: CORE,
        secret: CORE_SIGNING_SECRET,
        path: corePath,
        headers: portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {},
        copyHeaders: ["content-type", "content-length", "content-disposition"],
        responseHeaders: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }
    const result = await coreFetch("GET", corePath);
    const dev = vite && !external;
    let template: string;
    try {
      template = dev
        ? await vite!.transformIndexHtml("/shared.html", readFileSync(join(ROOT, "shared.html"), "utf8"))
        : await liveReleases().document("shared.html");
    } catch (error) {
      return releaseUnavailable(res, "shared.html", error);
    }
    res.writeHead(result.status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src ${dev ? "ws: wss:" : "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
    return res.end(
      sharedSessionHtml(await brandIndexHtml(template), result.status === 200 ? JSON.parse(result.text) : null),
    );
  }

  if (path.startsWith("/api/")) {
    const user = cookieUser(req);
    if (!user) return unauthorized(res, req);
    if (["/api/dictation", "/api/voice", "/api/voice/sessions"].includes(path)) {
      return handleVoiceRoute(req, res, path, resolveIdentity(req)!, {
        org: ORG,
        publicUrl: PUBLIC_URL,
      });
    }

    const inboxPath = path === "/api/inbox" || path.startsWith("/api/inbox/");
    const loopsPath = path === "/api/loops" || path.startsWith("/api/loops/");
    if ((inboxPath || loopsPath) && !(await hasInboxLoopPreview(user)))
      return json(res, 403, { error: "feature_disabled" });
    if (inboxPath && !isInboxUser(user)) return json(res, 403, { error: "forbidden" });
    const ledgerPath =
      /^\/api\/loops\/[^/]+\/items(\/|$)/.test(path) || /^\/api\/loops\/[^/]+\/outputs\/[^/]+\/decide$/.test(path);
    if (loopsPath && !isLoopsUser(user) && !(ledgerPath && isInboxUser(user))) {
      return json(res, 403, { error: "forbidden" });
    }
    const found = findRoute(apiRoutes, method, path);
    if (!found) return json(res, 404, { error: "not found" });
    return found.route.handle({ req, res, url, user, params: found.params });
  }

  if (method === "GET" && path === "/app-edit" && (await serveAppEditHtml(req, res, url))) return;

  if (method === "GET") {
    if (path.startsWith("/assets/")) return await serveStatic(res, path);
    if (await serveVite(req, res, path)) return;
    return await serveStatic(res, path === "/" ? "/index.html" : path);
  }

  json(res, 404, { error: "not found" });
};

export const handler = async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  try {
    await portalTokenStore.run(token, () => withRequestContext("web-ui", req, res, () => routeRequest(req, res)));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      if (!res.headersSent) json(res, 413, { error: "payload_too_large", message: err.message });
      else res.end();
      return;
    }
    throw err;
  }
};

const server = createServer((req, res) => {
  void handler(req, res).catch((err: unknown) => {
    reportBackendError(err);
    console.error("%s", `[web-ui] 502 ${req.method ?? "?"} ${req.url ?? "?"}:`, String(err));
    if (!res.headersSent) json(res, 502, { error: "bad_gateway", message: "upstream error" });
    else res.end();
  });
});

export async function startServer(options: { port: number; host: string; releases: WebReleases }): Promise<Server> {
  serveReleasesFrom(options.releases);
  vite = await createVite(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.log(
    `[web-ui] surface on http://${options.host}:${port} → core ${CORE} (org ${ORG})${WEB_UI_DEV ? " [vite hmr]" : ""}`,
  );
  if (ALLOW.length === 0) console.warn("[web-ui] WEB_UI_PRINCIPALS unset, any principal id may sign in (dev only)");
  void sweepDictationSpool();
  return server;
}
