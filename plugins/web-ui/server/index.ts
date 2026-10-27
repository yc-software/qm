import "./instrument.ts";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createUiDocuments, releaseErrorPage, uiProtocolSupported } from "./ui-releases.ts";
import { type ServerResponse, type IncomingMessage, type Server, createServer } from "node:http";
import {
  brandingCache,
  type WebRoute,
  enc,
  fetchCoreGet,
  portalHeaders,
  pipeUpstream,
  coreFetch,
  portalTokenStore,
} from "./core-relay.ts";
import { injectBranding } from "../../chassis/src/branding.ts";
import {
  analyticsKey,
  analyticsHost,
  browserErrors,
  analyticsConfig,
  appsFrameDomain,
  faviconSvg,
  framedByOwnSurfaces,
  PORT,
  publicUrl,
  slackServiceUrl,
} from "./server-env.ts";
import { sendBuffered, json, gzipAccepted, serveFavicon, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { existsSync, statSync, createReadStream, readFileSync } from "node:fs";
import { workspaceRoutes } from "./api-workspace.ts";
import { runRoutes } from "./api-runs.ts";
import { CORE_API_URL as CORE, coreOrgId, portalIdentitySecret } from "../../chassis/src/env.ts";
import { reportFailure, reportBackendError, flushErrorReporting } from "../../chassis/src/error-reporting.ts";
import { cookieUser, unauthorized, resolveIdentity } from "./identity.ts";
import { sharedSessionHtml } from "./shared-session.ts";
import { UI_VERSION_HEADER } from "../../chassis/src/ui-release.ts";
import { handleVoiceRoute, sweepDictationSpool } from "./voice-routes.ts";
import { hasInboxLoopPreview } from "./web-turns.ts";
import { findRoute } from "../../chassis/src/router.ts";
import { PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { startLiveFeeds } from "./live-feeds.ts";
import { coreTenantHost, serveForHost } from "../../chassis/src/tenant-hosts.ts";

const WEB_UI_DEV = process.env.WEB_UI_DEV === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");
const UI = createUiDocuments(DIST, process.env.WEB_UI_RELEASES_URL);
const uiDocument = UI.document;

async function sendReleaseError(res: ServerResponse, error: unknown): Promise<void> {
  const { selfLabel } = await brandingCache().forRender();
  const page = releaseErrorPage(error, typeof selfLabel === "string" ? selfLabel : undefined);
  sendHtml(res, page.status, page.html);
}

async function serveWebManifest(res: ServerResponse): Promise<void> {
  const branding = await brandingCache().forRender();
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
        src: faviconSvg() ? "/favicon.svg" : "/brand-mark.svg",
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
  const branding = await brandingCache().forRender();
  return injectBranding(html, branding, { titleSuffix: "· Web" });
}

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
if (analyticsKey && !/^phc_[A-Za-z0-9]+$/.test(analyticsKey))
  throw new Error("POSTHOG_API_KEY must be a public project ingestion token");
if (analyticsKey && (analyticsHost.protocol !== "https:" || analyticsHost.href !== `${analyticsHost.origin}/`))
  throw new Error("POSTHOG_HOST must be an HTTPS origin");
const browserErrorOrigin = browserErrors ? new URL(browserErrors.dsn).origin : undefined;

function spaCsp(): string {
  const slackService = slackServiceUrl();
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${analyticsConfig ? ` ${analyticsConfig.host}` : ""}${browserErrorOrigin ? ` ${browserErrorOrigin}` : ""}`,
    "frame-src 'self' data: https:",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    `form-action 'self'${slackService ? ` ${new URL(slackService).origin} https://slack.com` : ""}`,
    "object-src 'none'",
  ].join("; ");
}

function withSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "content-security-policy": spaCsp(),
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "referrer-policy": slackServiceUrl() ? "strict-origin" : "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  };
}

interface ViteDevServer {
  middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
  transformIndexHtml(url: string, html: string): Promise<string>;
}

type CreateViteServer = (opts: Record<string, unknown>) => Promise<ViteDevServer>;

function sendHtml(res: ServerResponse, status: number, html: string): void {
  sendBuffered(res, status, withSecurityHeaders({ "content-type": "text/html; charset=utf-8" }), html);
}

function callbackHtml(query: string): string {
  const safe = query.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../../../?${safe}"><title>Connector</title>`;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(DIST, rel);
  if (!filePath.startsWith(DIST)) return void json(res, 403, { error: "forbidden" });

  const isFile = existsSync(filePath) && statSync(filePath).isFile();
  const immutable = isFile && /(?:^|[/\\])assets[/\\]/.test(rel);
  const isDocument = filePath === join(DIST, "index.html") || (!isFile && !extname(rel));
  if (!isFile && !isDocument) return void json(res, 404, { error: "not_found" });
  if (isDocument) {
    let html: string | null;
    try {
      html = await uiDocument(res.req, "index.html");
    } catch (error) {
      return sendReleaseError(res, error);
    }
    if (html === null)
      return void json(res, 503, { error: "not_built", message: "run `npm run build` to produce dist-web/" });
    const headers = withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return sendBuffered(res, 200, headers, await brandIndexHtml(html));
  }
  const headers = withSecurityHeaders({
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    vary: "accept-encoding",
  });
  const packed = `${filePath}.gz`;
  if (gzipAccepted(res.req) && existsSync(packed)) {
    res.writeHead(200, { ...headers, "content-encoding": "gzip" });
    return void pipeFile(res, packed);
  }
  res.writeHead(200, headers);
  pipeFile(res, filePath);
}

function pipeFile(res: ServerResponse, filePath: string): void {
  const stream = createReadStream(filePath);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

async function serveAppEditHtml(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
  const appsDomain = appsFrameDomain();
  if (!appsDomain || !/^[a-z0-9-]{1,63}$/.test(slug)) return false;
  let html: string;
  if (vite) html = await viteIndexHtml(req);
  else {
    let document: string | null;
    try {
      document = await uiDocument(req, "index.html");
    } catch (error) {
      await sendReleaseError(res, error);
      return true;
    }
    if (document === null) return false;
    html = document;
  }
  const headers = withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  const csp = spaCsp().replace("frame-ancestors 'self'", `frame-ancestors 'self' ${slug}.${appsDomain}`);
  sendBuffered(res, 200, framedByOwnSurfaces(res, headers, csp), await brandIndexHtml(html));
  return true;
}

let vite: ViteDevServer | undefined;

async function createVite(server: Server): Promise<ViteDevServer | undefined> {
  if (!WEB_UI_DEV) return undefined;
  const { createServer: createViteServer } = (await import(import.meta.resolve("vite"))) as {
    createServer: CreateViteServer;
  };
  return createViteServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    configLoader: "runner",
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
    res.once("finish", resolve);
    res.once("close", resolve);
    vite!.middlewares(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
  if (res.headersSent || res.writableEnded) return true;
  if (extname(path)) return false;
  sendHtml(res, 200, await brandIndexHtml(await viteIndexHtml(req)));
  return true;
}

function viteIndexHtml(req: IncomingMessage): Promise<string> {
  const raw = readFileSync(join(ROOT, "index.html"), "utf8").replace("%BASE_URL%favicon.svg", "favicon.svg");
  return vite!.transformIndexHtml(req.url ?? "/", raw);
}

export const apiRoutes: readonly WebRoute[] = [...workspaceRoutes, ...runRoutes];

const routeRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && path === "/favicon.svg") {
    return serveFavicon(
      res,
      {
        svg: faviconSvg(),
        emoji: process.env.WEB_UI_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F",
      },
      "no-cache",
    );
  }
  if (method === "GET" && path === "/manifest.webmanifest") return serveWebManifest(res);
  if (method === "GET" && (path === "/admin" || path.startsWith("/admin/")) && !path.startsWith("/admin/api/")) {
    const rest = path.slice("/admin".length).replace(/^\/+/, "");
    res.writeHead(302, { location: `/settings/${rest || "history"}${url.search}`, "cache-control": "no-store" });
    return res.end();
  }

  let oauthCallbackPrefix: string | null = null;
  if (path.startsWith("/v1/connectors/oauth/")) oauthCallbackPrefix = "/v1/connectors/oauth/";
  else if (path.startsWith("/connectors/oauth/")) oauthCallbackPrefix = "/connectors/oauth/";
  if (method === "GET" && oauthCallbackPrefix && path.endsWith("/callback")) {
    const provider = path.slice(oauthCallbackPrefix.length, -"/callback".length);
    const corePath = `/v1/connectors/oauth/${enc(provider)}/callback${url.search}`;
    let ok: boolean;
    try {
      const r = await fetch(`${CORE}${corePath}`, { redirect: "manual", headers: coreTenantHost() });
      ok = r.status >= 200 && r.status < 300;
      if (!ok)
        console.warn(
          `[web-ui] ${provider} OAuth callback: core returned HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`,
        );
    } catch (error) {
      reportFailure("web-ui: OAuth callback core unreachable", error, provider);
      ok = false;
    }
    const q = `view=keychain&connector=${enc(provider)}&status=${ok ? "connected" : "error"}`;
    return sendHtml(res, ok ? 200 : 400, callbackHtml(q));
  }

  if (method === "GET" && path.startsWith("/share/")) {
    const match = path.match(/^\/share\/(internal|external)\/([a-f0-9-]{36})(?:\/files\/([a-f0-9-]{36}))?$/);
    if (!match) return json(res, 404, { error: "not_found" });
    const external = match[1] === "external";
    const user = external ? null : cookieUser(req);
    if (!external && !user) return json(res, 401, { error: "sign in" });
    const corePath = `/v1/${external ? "public-shares" : "shared-sessions"}/${match[2]}${match[3] ? `/files/${match[3]}` : ""}?${external ? "" : `viewer=${enc(user!)}&`}inline=${url.searchParams.get("inline") === "1" ? "1" : "0"}`;
    if (match[3]) {
      const response = await fetchCoreGet(corePath, { redirect: "manual" }, external ? {} : portalHeaders());
      return pipeUpstream(res, response, ["content-type", "content-length", "content-disposition"], {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      });
    }
    const result = await coreFetch("GET", corePath);
    const dev = vite && !external;
    let template: string | null;
    try {
      template = dev
        ? await vite!.transformIndexHtml("/shared.html", readFileSync(join(ROOT, "shared.html"), "utf8"))
        : await uiDocument(req, "shared.html");
    } catch (error) {
      return sendReleaseError(res, error);
    }
    if (template === null) return json(res, 503, { error: "not_built" });
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

  if (path === "/me" || path.startsWith("/api/")) {
    if (!uiProtocolSupported(req.headers[UI_VERSION_HEADER]))
      return json(res, 409, { error: "ui_outdated", message: "This page is out of date. Reload to continue." });
    const user = cookieUser(req);
    if (!user) return unauthorized(res, req);
    if (["/api/dictation", "/api/voice", "/api/voice/sessions"].includes(path)) {
      return handleVoiceRoute(req, res, path, resolveIdentity(req)!, {
        org: coreOrgId(),
        publicUrl: publicUrl(),
      });
    }

    const inboxPath = path === "/api/inbox" || path.startsWith("/api/inbox/");
    const itemsPath = /^\/api\/crons\/[^/]+\/items(\/|$)/.test(path);
    if ((inboxPath || itemsPath) && !(await hasInboxLoopPreview(user)))
      return json(res, 403, { error: "feature_disabled" });
    const found = findRoute(apiRoutes, method, path);
    if (!found) return json(res, 404, { error: "not found" });
    return found.route.handle({ req, res, url, user, params: found.params });
  }

  if (method === "GET" && path === "/app-edit" && (await serveAppEditHtml(req, res, url))) return;

  if (method === "GET") {
    if (path.startsWith("/assets/")) return await (UI.relayAsset ? UI.relayAsset(res, path) : serveStatic(res, path));
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
    await portalTokenStore.run(token, () => routeRequest(req, res));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      if (!res.headersSent) json(res, 413, { error: "payload_too_large", message: err.message });
      else res.end();
      return;
    }
    throw err;
  }
};

function respond(req: IncomingMessage, res: ServerResponse): void {
  void handler(req, res).catch((err: unknown) => {
    reportBackendError(err);
    console.error("%s", `[web-ui] 502 ${req.method ?? "?"} ${req.url ?? "?"}:`, String(err));
    if (!res.headersSent) json(res, 502, { error: "bad_gateway", message: "upstream error" });
    else res.end();
  });
}

export const server = createServer((req, res) => serveForHost(req, res, () => respond(req, res)));

export async function startServer(port = PORT, host?: string): Promise<Server> {
  vite = await createVite(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.log(
    `[web-ui] surface on http://${host ?? "localhost"}:${bound} → core ${CORE} (org ${coreOrgId()})${WEB_UI_DEV ? " [vite hmr]" : ""}`,
  );
  if (!WEB_UI_DEV && !existsSync(join(DIST, "index.html")))
    console.warn("[web-ui] dist-web/ not built, run `npm run build`");
  if (!portalIdentitySecret())
    console.warn("[web-ui] no CORE_SIGNING_SECRET or PORTAL_IDENTITY_SECRET; every request will be refused");
  startLiveFeeds();
  void sweepDictationSpool();
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch(async (err: unknown) => {
    reportBackendError(err);
    console.error("[web-ui] failed to start:", String(err));
    await flushErrorReporting();
    process.exit(1);
  });
}
