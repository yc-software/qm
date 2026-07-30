import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { LRUCache } from "lru-cache";
import {
  signedHeaders,
  withSourceAuthNonce,
  CAPABILITY_HEADER,
  type HttpMethod,
} from "../../chassis/src/core-client.ts";
import {
  json,
  readBody as readBodyCapped,
  cookie,
  PayloadTooLargeError,
  serveEmojiFavicon,
} from "../../chassis/src/http.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { createBrandingCache, injectBranding } from "../../chassis/src/branding.ts";
import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
  portFromEnv,
} from "../../chassis/src/env.ts";

const PORT = portFromEnv(8096);
const PUBLIC_URL = (process.env.WEB_UI_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const WEB_UI_DEV = process.env.WEB_UI_DEV === "1";
const ALLOW_UNSIGNED_TEST_IDENTITY =
  process.env.NODE_ENV === "test" && process.env.ALLOW_UNSIGNED_TEST_IDENTITY === "1";
const COOKIE_AUTH = !CORE_SIGNING_SECRET || ALLOW_UNSIGNED_TEST_IDENTITY;
const AUTH_MODE = COOKIE_AUTH ? "dev" : "portal";
const ALLOW = (process.env.WEB_UI_PRINCIPALS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");

const brandingCache = createBrandingCache(async () => {
  const r = await coreFetch("GET", "/v1/surface-config", "", 2_000);
  if (r.status !== 200) throw new Error(`surface-config ${r.status}`);
  const b = (JSON.parse(r.text) as { branding?: Record<string, unknown> }).branding;
  return {
    ...(typeof b?.accent === "string" ? { accent: b.accent } : {}),
    ...(typeof b?.mark === "string" ? { mark: b.mark } : {}),
    ...(typeof b?.selfLabel === "string" ? { selfLabel: b.selfLabel } : {}),
  };
});

async function brandIndexHtml(html: string): Promise<string> {
  const branding = await brandingCache.forRender();
  const branded = injectBranding(html, branding);
  const label = branding.selfLabel?.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return label ? branded.replace(/<title>[^<]*<\/title>/, () => `<title>${label} · Web</title>`) : branded;
}

const portalTokenStore = new AsyncLocalStorage<string | undefined>();

const runOwners = new Map<string, string>();
const runThreadKeys = new Map<string, string>();
const activeRunsByThread = new Map<string, string[]>();

function ownsRun(runId: string, user: string): boolean {
  return runOwners.get(runId) === user;
}

function threadKey(user: string, threadRef: string): string {
  return `${user}\0${threadRef}`;
}

function forgetRun(runId: string): void {
  runOwners.delete(runId);
  const key = runThreadKeys.get(runId);
  if (key) {
    const remaining = (activeRunsByThread.get(key) ?? []).filter((id) => id !== runId);
    if (remaining.length) activeRunsByThread.set(key, remaining);
    else activeRunsByThread.delete(key);
  }
  runThreadKeys.delete(runId);
}

function rememberRun(runId: string, user: string, threadRef: string): void {
  if (runOwners.size > 5000) {
    const oldest = runOwners.keys().next().value;
    if (oldest !== undefined) forgetRun(oldest);
  }
  runOwners.set(runId, user);
  const key = threadKey(user, threadRef);
  runThreadKeys.set(runId, key);
  activeRunsByThread.set(key, [...(activeRunsByThread.get(key) ?? []), runId]);
}

const deliveryClients = new Map<string, Set<ServerResponse>>();

function ownerOfWebThread(threadRef: string): string | null {
  if (!threadRef.startsWith("web:")) return null;
  const rest = threadRef.slice("web:".length);
  const i = rest.indexOf(":");
  return i > 0 ? rest.slice(0, i) : null;
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

const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function withSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "content-security-policy": SPA_CSP,
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  };
}

const UNTRUSTED_CONTENT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

interface ViteDevServer {
  middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
  transformIndexHtml(url: string, html: string): Promise<string>;
}

type CreateViteServer = (opts: Record<string, unknown>) => Promise<ViteDevServer>;

function relay(res: ServerResponse, r: { status: number; text: string }): void {
  res.writeHead(r.status, { "content-type": "application/json", "x-content-type-options": "nosniff" });
  res.end(r.text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, withSecurityHeaders({ "content-type": "text/html; charset=utf-8" }));
  res.end(html);
}

const SSE_CORE_POLL_MS = 100;
const SSE_STALE_POLL_MS = 1_000;
const SSE_IDLE_MS = 6 * 60_000;
const SSE_STALE_GRACE_MS = 10 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

function conversationForScope(
  user: string,
  threadRef: string,
  scope: string | undefined,
  channelName: string | undefined,
): { kind: "dm" | "channel" | "group"; threadRef: string; channelRef?: string; channelName?: string } | null {
  if (!scope || scope === `personal:${user}`) return { kind: "dm", threadRef };
  const sep = scope.indexOf(":");
  const kind = scope.slice(0, sep);
  const ref = scope.slice(sep + 1);
  if ((kind !== "channel" && kind !== "group") || !ref) return null;
  return { kind, channelRef: ref, threadRef, ...(channelName ? { channelName } : {}) };
}

function resolveIdentity(
  req: IncomingMessage,
): { user: string; name: string | null; impersonator: string | null } | null {
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
    if (!COOKIE_AUTH) return null;
    user = cookie(req, "webuiuser");
    name = cookie(req, "webuiuser_name");
    impersonator = cookie(req, "webui_impersonator");
  }
  if (!user) return null;
  if (ALLOW.length > 0 && !ALLOW.includes(user)) return null;
  return { user, name: name?.trim() || null, impersonator: impersonator ?? null };
}

function cookieUser(req: IncomingMessage): string | null {
  return resolveIdentity(req)?.user ?? null;
}

const SESSION_TTL_S = 90 * 24 * 60 * 60;
function sessionCookie(id: string): string {
  return `webuiuser=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

const MAX_BODY_BYTES = 1_000_000;
const readBody = (req: IncomingMessage): Promise<string> => readBodyCapped(req, MAX_BODY_BYTES);

const slackUrlCache = new LRUCache<string, { url: string | null }>({ max: 1, ttl: 5 * 60_000 });
async function slackWorkspaceUrl(): Promise<string | null> {
  const hit = slackUrlCache.get("url");
  if (hit) return hit.url;
  let urlValue: string | null = null;
  try {
    const r = await coreFetch("GET", "/v1/directory/meta");
    if (r.status === 200) urlValue = (JSON.parse(r.text) as { workspaceUrl?: string | null }).workspaceUrl ?? null;
  } catch {
    void 0;
  }
  slackUrlCache.set("url", { url: urlValue });
  return urlValue;
}

const WEB_DELIVERY_POLL_MS = Number(process.env.WEB_DELIVERY_POLL_MS ?? 2500);
const WEB_DELIVERY_GIVEUP_MS = 60_000;
let deliveriesPollInFlight = false;

interface PendingWebDelivery {
  id: string;
  idempotencyKey: string;
  createdAt: number;
  destination?: { target?: string };
}

async function drainWebDeliveries(): Promise<void> {
  if (deliveriesPollInFlight) return;
  deliveriesPollInFlight = true;
  try {
    const r = await coreFetch("GET", "/v1/deliveries?type=web");
    if (r.status !== 200) return;
    let pending: PendingWebDelivery[] = [];
    try {
      pending = (JSON.parse(r.text) as { deliveries?: PendingWebDelivery[] }).deliveries ?? [];
    } catch {
      return;
    }
    const now = Date.now();
    for (const d of pending) {
      const target = d.destination?.target ?? "";
      const isRecovery = d.idempotencyKey.startsWith("run:");
      const conns = !isRecovery ? deliveryClients.get(ownerOfWebThread(target) ?? "") : undefined;
      if (conns && conns.size) {
        for (const res of conns) sseEvent(res, "delivery", { threadRef: target });
      } else if (!isRecovery && now - (d.createdAt ?? 0) < WEB_DELIVERY_GIVEUP_MS) {
        continue;
      }
      await coreFetch("POST", `/v1/deliveries/${encodeURIComponent(d.id)}/ack`).catch(() => {});
    }
  } catch {
    void 0;
  } finally {
    deliveriesPollInFlight = false;
  }
}

const STATE_FEED_RECONNECT_MS = Number(process.env.STATE_FEED_RECONNECT_MS ?? 3_000);

interface SessionStateFrame {
  threadRef?: string;
  state?: string;
  participants?: string[];
  [k: string]: unknown;
}

function forwardSessionState(frame: SessionStateFrame): void {
  const threadRef = typeof frame.threadRef === "string" ? frame.threadRef : "";
  if (!threadRef) return;
  const targets = new Set<string>(
    Array.isArray(frame.participants) ? frame.participants.filter((p): p is string => typeof p === "string") : [],
  );
  if (targets.size === 0) {
    const owner = ownerOfWebThread(threadRef);
    if (owner) targets.add(owner);
  }
  const { participants: _participants, ...visible } = frame;
  for (const user of targets) {
    for (const res of deliveryClients.get(user) ?? []) sseEvent(res, "session_state", visible);
  }
}

async function runStateFeed(): Promise<void> {
  let dropped = false;
  for (;;) {
    try {
      const signedPath = withSourceAuthNonce("/v1/session-state/events", CORE_SIGNING_SECRET);
      const r = await fetch(`${CORE}${signedPath}`, {
        headers: signedHeaders(CORE_SIGNING_SECRET, "GET", signedPath, ""),
      });
      if (r.status === 200 && r.body) {
        if (dropped) {
          dropped = false;
          for (const conns of deliveryClients.values())
            for (const res of conns) sseEvent(res, "session_state_resync", {});
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.split("\n").some((l) => l === "event: session_state")) continue;
            const data = frame
              .split("\n")
              .find((l) => l.startsWith("data: "))
              ?.slice("data: ".length);
            if (!data) continue;
            try {
              forwardSessionState(JSON.parse(data) as SessionStateFrame);
            } catch {
              void 0;
            }
          }
        }
      }
      dropped = true;
    } catch {
      dropped = true;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_FEED_RECONNECT_MS));
  }
}

async function coreFetch(
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
  timeoutMs?: number,
): Promise<{ status: number; text: string }> {
  const signedPath = withSourceAuthNonce(pathWithQuery, CORE_SIGNING_SECRET);
  const portalTok = portalTokenStore.getStore();
  const r = await fetch(`${CORE}${signedPath}`, {
    method,
    headers: {
      ...signedHeaders(CORE_SIGNING_SECRET, method, signedPath, rawBody),
      ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
    },
    ...(rawBody ? { body: rawBody } : {}),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    redirect: "manual",
  });
  return { status: r.status, text: await r.text() };
}

async function coreFetchCap(
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
): Promise<{ status: number; text: string }> {
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
  const r = await fetch(`${CORE}${pathWithQuery}`, {
    method,
    headers: { "content-type": "application/json", [CAPABILITY_HEADER]: token },
    ...(rawBody ? { body: rawBody } : {}),
    redirect: "manual",
  });
  return { status: r.status, text: await r.text() };
}

async function postTurnAndMint(res: ServerResponse, turn: unknown, user: string, threadRef: string): Promise<void> {
  const r = await coreFetch("POST", `/v1/turns?async=1`, JSON.stringify(turn));
  if (r.status >= 200 && r.status < 300) {
    try {
      const parsed = JSON.parse(r.text) as Record<string, unknown> & { runId?: string };
      const runId = parsed.runId;
      if (runId) {
        rememberRun(runId, user, threadRef);
        return json(res, r.status, parsed);
      }
    } catch {
      void 0;
    }
  }
  relay(res, r);
}

async function userPermissions(): Promise<string[]> {
  if (!CORE_SIGNING_SECRET) return [];
  try {
    const r = await coreFetchCap("GET", "/v1/admin/whoami");
    if (r.status !== 200) return [];
    const j = JSON.parse(r.text) as { permissions?: unknown };
    return Array.isArray(j.permissions) ? j.permissions.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
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

interface CoreAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

interface CoreApprovalRecord {
  requestId: string;
  sessionId?: unknown;
  command: string;
  reason?: string;
  request?: {
    surface?: string;
    actor?: { externalId?: unknown };
    conversation?: { threadRef?: unknown };
    text?: unknown;
  } & Record<string, unknown>;
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
  res.writeHead(staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" });
  return void res.end(await staged.text());
}

async function uploadFileFromRequest(
  req: IncomingMessage,
  res: ServerResponse,
  user: string,
  scope: string | null,
  sha256: string,
  name: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
  }
  const staged = await stageUploadStream(req, sha256);
  const stagedText = await staged.text();
  if (!staged.ok) {
    res.writeHead(staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" });
    return void res.end(stagedText);
  }
  const stagedBody = JSON.parse(stagedText) as { blobId: string };
  const body = JSON.stringify({
    principalId: user,
    ...(scope ? { scopeId: scope } : {}),
    name,
    mimetype:
      typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
    blobId: stagedBody.blobId,
  });
  const registered = await coreFetch("POST", "/v1/files/upload", body);
  res.writeHead(registered.status, { "content-type": "application/json" });
  return void res.end(registered.text);
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(DIST, rel);
  if (!filePath.startsWith(DIST)) return void json(res, 403, { error: "forbidden" });

  const isFile = existsSync(filePath) && statSync(filePath).isFile();
  const immutable = isFile && /(?:^|[/\\])assets[/\\]/.test(rel);
  if (!isFile) {
    if (extname(rel)) return void json(res, 404, { error: "not_found" });
    filePath = join(DIST, "index.html");
    if (!existsSync(filePath)) {
      return void json(res, 503, { error: "not_built", message: "run `npm run build` to produce dist-web/" });
    }
  }
  if (filePath.endsWith("index.html")) {
    const branded = await brandIndexHtml(readFileSync(filePath, "utf8"));
    res.writeHead(
      200,
      withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }),
    );
    return void res.end(branded);
  }
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(
    200,
    withSecurityHeaders({
      "content-type": type,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    }),
  );
  createReadStream(filePath).pipe(res);
}

const APPS_FRAME_DOMAIN = (process.env.DEPLOY_APPS_DOMAIN ?? "").toLowerCase();

async function serveAppEditHtml(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
  if (!APPS_FRAME_DOMAIN || !/^[a-z0-9-]{1,63}$/.test(slug)) return false;
  let html: string;
  if (vite) {
    const raw = readFileSync(join(ROOT, "index.html"), "utf8").replace("%BASE_URL%favicon.svg", "favicon.svg");
    html = await vite.transformIndexHtml(req.url ?? "/", raw);
  } else {
    const filePath = join(DIST, "index.html");
    if (!existsSync(filePath)) return false;
    html = readFileSync(filePath, "utf8");
  }
  const headers = withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  headers["content-security-policy"] = SPA_CSP.replace(
    "frame-ancestors 'self'",
    `frame-ancestors 'self' ${slug}.${APPS_FRAME_DOMAIN}`,
  );
  delete headers["x-frame-options"];
  res.removeHeader("x-frame-options");
  res.writeHead(200, headers);
  res.end(await brandIndexHtml(html));
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

const routeRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && path === "/favicon.svg") {
    return serveEmojiFavicon(res, process.env.WEB_UI_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F", "no-cache");
  }

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

  let oauthCallbackPrefix: string | null = null;
  if (path.startsWith("/v1/connectors/oauth/")) oauthCallbackPrefix = "/v1/connectors/oauth/";
  else if (path.startsWith("/connectors/oauth/")) oauthCallbackPrefix = "/connectors/oauth/";
  if (method === "GET" && oauthCallbackPrefix && path.endsWith("/callback")) {
    const provider = path.slice(oauthCallbackPrefix.length, -"/callback".length);
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

  if (path === "/me" || path.startsWith("/api/")) {
    const user = cookieUser(req);
    if (!user) return json(res, 401, { error: "sign in", mode: AUTH_MODE });

    if (path === "/me") {
      res.setHeader("set-cookie", sessionCookie(user));
      const permissions = await userPermissions();
      return json(res, 200, {
        user,
        org: ORG,
        mode: AUTH_MODE,
        slackWorkspaceUrl: await slackWorkspaceUrl(),
        impersonatedBy: resolveIdentity(req)?.impersonator ?? null,
        permissions,
      });
    }

    if (method === "POST" && path === "/api/blobs") {
      return uploadBlobFromRequest(req, res, declaredSha(url));
    }

    if (method === "POST" && path === "/api/files/upload") {
      return uploadFileFromRequest(
        req,
        res,
        user,
        url.searchParams.get("scope"),
        declaredSha(url),
        uploadFileName(url),
      );
    }

    if (method === "GET" && path === "/api/sessions") {
      const r = await coreFetch("GET", `/v1/sessions?principalId=${encodeURIComponent(user)}`);
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/contexts") {
      const r = await coreFetch("GET", `/v1/contexts?principalId=${encodeURIComponent(user)}`);
      return relay(res, r);
    }

    const contextPolicy = path.match(/^\/api\/contexts\/([^/]+)\/ambient-policy$/);
    if (method === "GET" && contextPolicy) {
      const scope = decodeURIComponent(contextPolicy[1]!);
      const r = await coreFetch(
        "GET",
        `/v1/contexts/policy?principalId=${encodeURIComponent(user)}&scope=${encodeURIComponent(scope)}`,
      );
      return relay(res, r);
    }
    if (method === "PUT" && contextPolicy) {
      const scope = decodeURIComponent(contextPolicy[1]!);
      let p: { orders?: unknown; bots?: unknown; ambientEnabled?: unknown; baseUpdatedAt?: unknown };
      try {
        p = JSON.parse((await readBody(req)) || "{}") as typeof p;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch(
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
      return relay(res, r);
    }

    if (method === "POST" && path === "/api/projects") {
      let name = "";
      try {
        const p = JSON.parse((await readBody(req)) || "{}") as { name?: unknown };
        if (typeof p.name === "string") name = p.name.trim().slice(0, 200);
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      if (!name) return json(res, 400, { error: "bad_request", message: "name required" });
      const r = await coreFetch("POST", "/v1/projects", JSON.stringify({ principalId: user, name }));
      return relay(res, r);
    }

    const renameProject = path.match(/^\/api\/projects\/([^/]+)$/);
    if (method === "PATCH" && renameProject) {
      const id = decodeURIComponent(renameProject[1]!);
      let name = "";
      try {
        const p = JSON.parse((await readBody(req)) || "{}") as { name?: unknown };
        if (typeof p.name === "string") name = p.name.trim().slice(0, 200);
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      if (!name) return json(res, 400, { error: "bad_request", message: "name required" });
      const r = await coreFetch(
        "PATCH",
        `/v1/projects/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user, name }),
      );
      return relay(res, r);
    }

    const addProjectMember = path.match(/^\/api\/projects\/([^/]+)\/members$/);
    if (method === "POST" && addProjectMember) {
      const id = decodeURIComponent(addProjectMember[1]!);
      let memberId = "";
      try {
        const p = JSON.parse((await readBody(req)) || "{}") as { memberId?: unknown };
        if (typeof p.memberId === "string") memberId = p.memberId.trim();
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      if (!memberId) return json(res, 400, { error: "bad_request", message: "memberId required" });
      const r = await coreFetch(
        "POST",
        `/v1/projects/${encodeURIComponent(id)}/members`,
        JSON.stringify({ principalId: user, memberId }),
      );
      return relay(res, r);
    }

    const removeProjectMember = path.match(/^\/api\/projects\/([^/]+)\/members\/([^/]+)$/);
    if (method === "DELETE" && removeProjectMember) {
      const id = decodeURIComponent(removeProjectMember[1]!);
      const memberId = decodeURIComponent(removeProjectMember[2]!);
      const r = await coreFetch(
        "DELETE",
        `/v1/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`,
        JSON.stringify({ principalId: user }),
      );
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/directory/resolve") {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
      if (!q) return json(res, 400, { error: "bad_request", message: "q required" });
      const r = await coreFetch("GET", `/v1/directory/resolve?q=${encodeURIComponent(q)}`);
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/surface-config") {
      const r = await coreFetch("GET", "/v1/surface-config");
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/runtime-config") {
      const scopeId = url.searchParams.get("scopeId") || `personal:${user}`;
      const qs = new URLSearchParams({ principalId: user, scopeId });
      const r = await coreFetch("GET", `/v1/runtime-config?${qs.toString()}`);
      return relay(res, r);
    }

    if (method === "PUT" && path === "/api/runtime-config") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "bad_request" });
      }
      const scopeId = typeof body.scopeId === "string" && body.scopeId ? body.scopeId : `personal:${user}`;
      const r = await coreFetch("PUT", "/v1/runtime-config", JSON.stringify({ ...body, principalId: user, scopeId }));
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/scope-resources") {
      const scope = url.searchParams.get("scope");
      if (!scope) return json(res, 400, { error: "bad_request", message: "scope required" });
      const qs = new URLSearchParams({ principalId: user, scope });
      const r = await coreFetch("GET", `/v1/scope-resources?${qs.toString()}`);
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/skills") {
      const qs = new URLSearchParams({ principalId: user });
      if (url.searchParams.get("includeShadowed") === "1") qs.set("includeShadowed", "1");
      const r = await coreFetch("GET", `/v1/skills?${qs.toString()}`);
      return relay(res, r);
    }

    if (method === "GET" && path.startsWith("/api/skills/")) {
      const id = decodeURIComponent(path.slice("/api/skills/".length));
      const r = await coreFetch("GET", `/v1/skills/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`);
      return relay(res, r);
    }

    if (method === "POST" && path === "/api/skills") {
      const draft: { name?: string; description?: string; body?: string; scopeId?: string } = {};
      try {
        const p = JSON.parse((await readBody(req)) || "{}") as {
          name?: unknown;
          description?: unknown;
          body?: unknown;
          scopeId?: unknown;
        };
        if (typeof p.name === "string") draft.name = p.name;
        if (typeof p.description === "string") draft.description = p.description;
        if (typeof p.body === "string") draft.body = p.body;
        if (typeof p.scopeId === "string") draft.scopeId = p.scopeId;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch("POST", "/v1/skills", JSON.stringify({ principalId: user, ...draft }));
      return relay(res, r);
    }

    if (method === "PUT" && path.startsWith("/api/skills/")) {
      const id = decodeURIComponent(path.slice("/api/skills/".length));
      const patch: { description?: string; body?: string } = {};
      try {
        const p = JSON.parse((await readBody(req)) || "{}") as { description?: unknown; body?: unknown };
        if (typeof p.description === "string") patch.description = p.description;
        if (typeof p.body === "string") patch.body = p.body;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch(
        "PUT",
        `/v1/skills/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user, ...patch }),
      );
      return relay(res, r);
    }

    if (method === "DELETE" && path.startsWith("/api/skills/")) {
      const id = decodeURIComponent(path.slice("/api/skills/".length));
      const r = await coreFetch(
        "DELETE",
        `/v1/skills/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user }),
      );
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/skills/") && path.endsWith("/restore")) {
      const id = decodeURIComponent(path.slice("/api/skills/".length, -"/restore".length));
      const r = await coreFetch(
        "POST",
        `/v1/skills/${encodeURIComponent(id)}/restore`,
        JSON.stringify({ principalId: user }),
      );
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/sessions/") && path.endsWith("/title")) {
      const id = decodeURIComponent(path.slice("/api/sessions/".length, -"/title".length));
      const r = await coreFetch(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/title`,
        JSON.stringify({ principalId: user }),
      );
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/sessions/") && path.endsWith("/fork")) {
      const id = decodeURIComponent(path.slice("/api/sessions/".length, -"/fork".length));
      let upToSeq: number | undefined;
      try {
        const p = JSON.parse((await readBody(req)) || "{}") as { upToSeq?: unknown };
        if (typeof p.upToSeq === "number") upToSeq = p.upToSeq;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/fork`,
        JSON.stringify({ principalId: user, ...(upToSeq !== undefined ? { upToSeq } : {}) }),
      );
      return relay(res, r);
    }

    if (method === "GET" && path.startsWith("/api/sessions/") && path.endsWith("/approvals")) {
      const id = decodeURIComponent(path.slice("/api/sessions/".length, -"/approvals".length));
      const r = await coreFetch(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/approvals?viewer=${encodeURIComponent(user)}`,
      );
      return relay(res, r);
    }

    const bgOutput = path.match(/^\/api\/sessions\/([^/]+)\/background\/([^/]+)\/output$/);
    if (method === "GET" && bgOutput) {
      const id = decodeURIComponent(bgOutput[1]!);
      const pid = decodeURIComponent(bgOutput[2]!);
      const sinceCursor = url.searchParams.get("sinceCursor") ?? "0";
      const r = await coreFetch(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/background/${encodeURIComponent(pid)}/output?viewer=${encodeURIComponent(user)}&sinceCursor=${encodeURIComponent(sinceCursor)}`,
      );
      return relay(res, r);
    }
    if (method === "GET" && path.startsWith("/api/sessions/") && path.endsWith("/background")) {
      const id = decodeURIComponent(path.slice("/api/sessions/".length, -"/background".length));
      const r = await coreFetch(
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/background?viewer=${encodeURIComponent(user)}`,
      );
      return relay(res, r);
    }

    if (method === "GET" && path.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(path.slice("/api/sessions/".length));
      const qs = new URLSearchParams({ viewer: user });
      for (const p of ["tailTurns", "sinceSeq", "beforeSeq"] as const) {
        const v = url.searchParams.get(p);
        if (v !== null) qs.set(p, v);
      }
      const r = await coreFetch("GET", `/v1/sessions/${encodeURIComponent(id)}?${qs.toString()}`);
      return relay(res, r);
    }

    if (method === "GET" && path.startsWith("/api/files/") && path.endsWith("/content")) {
      const id = decodeURIComponent(path.slice("/api/files/".length, -"/content".length));
      const corePath = withSourceAuthNonce(
        `/v1/files/${encodeURIComponent(id)}/content?viewer=${encodeURIComponent(user)}`,
        CORE_SIGNING_SECRET,
      );
      const portalTok = portalTokenStore.getStore();
      const r = await fetch(`${CORE}${corePath}`, {
        headers: {
          ...signedHeaders(CORE_SIGNING_SECRET, "GET", corePath, ""),
          ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
        },
        redirect: "manual",
      });
      if (!r.ok || !r.body) {
        res.writeHead(r.status === 404 ? 404 : 502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: r.status === 404 ? "not_found" : "upstream_error" }));
      }
      res.writeHead(200, {
        "content-type": r.headers.get("content-type") ?? "application/octet-stream",
        ...(r.headers.get("content-length") ? { "content-length": r.headers.get("content-length")! } : {}),
        ...(r.headers.get("content-disposition")
          ? { "content-disposition": r.headers.get("content-disposition")! }
          : {}),
        "content-security-policy": UNTRUSTED_CONTENT_SANDBOX_CSP,
        "x-content-type-options": "nosniff",
      });
      return Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    }

    if (method === "GET" && path === "/api/files") {
      const qs = new URLSearchParams({ viewer: user });
      const limit = url.searchParams.get("limit");
      if (limit) qs.set("limit", limit);
      const cursor = url.searchParams.get("cursor");
      if (cursor) qs.set("cursor", cursor);
      const scope = url.searchParams.get("scope");
      if (scope) qs.set("scope", scope);
      const r = await coreFetch("GET", `/v1/files?${qs.toString()}`);
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/memory") {
      const r = await coreFetch("GET", `/v1/memory?principalId=${encodeURIComponent(user)}`);
      return relay(res, r);
    }
    if (method === "GET" && path === "/api/memory/history") {
      const r = await coreFetch("GET", `/v1/memory/history?principalId=${encodeURIComponent(user)}`);
      return relay(res, r);
    }
    if (method === "POST" && path === "/api/memory/restore") {
      let revision = "";
      let expectedRevision = "";
      try {
        const p = JSON.parse(await readBody(req)) as { revision?: unknown; expectedRevision?: unknown };
        if (typeof p.revision === "string") revision = p.revision;
        if (typeof p.expectedRevision === "string") expectedRevision = p.expectedRevision;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch(
        "POST",
        "/v1/memory/restore",
        JSON.stringify({ principalId: user, revision, expectedRevision }),
      );
      return relay(res, r);
    }
    if (method === "PUT" && path === "/api/memory") {
      let content: string;
      let revision: string;
      try {
        const p = JSON.parse(await readBody(req)) as { content?: unknown; revision?: unknown };
        if (typeof p.content !== "string")
          return json(res, 400, { error: "bad_request", message: "content must be a string" });
        content = p.content;
        revision =
          typeof p.revision === "string"
            ? p.revision
            : await coreFetch("GET", `/v1/memory?principalId=${encodeURIComponent(user)}`).then((head) => {
                try {
                  return String((JSON.parse(head.text) as { revision?: unknown }).revision ?? "");
                } catch {
                  return "";
                }
              });
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch("PUT", "/v1/memory", JSON.stringify({ principalId: user, content, revision }));
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(path.slice("/api/sessions/".length));
      const patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null } = {};
      try {
        const p = JSON.parse(await readBody(req)) as {
          title?: unknown;
          archived?: unknown;
          pinned?: unknown;
          color?: unknown;
        };
        if (p.title === null || typeof p.title === "string") patch.title = p.title as string | null;
        if (typeof p.archived === "boolean") patch.archived = p.archived;
        if (typeof p.pinned === "boolean") patch.pinned = p.pinned;
        if (p.color === null || typeof p.color === "string") patch.color = p.color as string | null;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      if (
        patch.title === undefined &&
        patch.archived === undefined &&
        patch.pinned === undefined &&
        patch.color === undefined
      ) {
        return json(res, 400, { error: "bad_request", message: "title, archived, pinned, or color required" });
      }
      const r = await coreFetch(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user, ...patch }),
      );
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/connectors") {
      const r = await coreFetch("GET", `/v1/connectors/oauth/status?principalId=${encodeURIComponent(user)}`);
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/connectors/") && path.endsWith("/start")) {
      const provider = path.slice("/api/connectors/".length, -"/start".length);
      const callback = `${PUBLIC_URL}/v1/connectors/oauth/${encodeURIComponent(provider)}/callback`;
      const params = new URLSearchParams({ principalId: user, redirectUri: callback, returnTo: "/keychain" });
      const corePath = `/v1/connectors/oauth/${encodeURIComponent(provider)}/start?${params.toString()}`;
      const r = await coreFetch("GET", corePath);
      return relay(res, r);
    }

    if (method === "POST" && path === "/api/connectors/revoke") {
      let provider: string;
      let host: string;
      try {
        const parsed = JSON.parse(await readBody(req)) as { provider?: unknown; host?: unknown };
        provider = typeof parsed.provider === "string" ? parsed.provider : "";
        host = typeof parsed.host === "string" ? parsed.host : "";
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      if (!provider && !host) return json(res, 400, { error: "bad_request", message: "provider or host required" });
      const rawBody = JSON.stringify({ principalId: user, ...(provider ? { provider } : { host }) });
      const r = await coreFetch("POST", "/v1/connectors/oauth/revoke", rawBody);
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/keychain/credentials") {
      const r = await coreFetchCap("GET", "/v1/keychain/credentials");
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/keychain/overview") {
      const r = await coreFetchCap("GET", "/v1/keychain/overview");
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/keychain/grants/") && path.endsWith("/revoke")) {
      const id = decodeURIComponent(path.slice("/api/keychain/grants/".length, -"/revoke".length));
      const r = await coreFetchCap("POST", `/v1/keychain/grants/${encodeURIComponent(id)}/revoke`, "{}");
      return relay(res, r);
    }

    if (method === "POST" && path === "/api/keychain/drops") {
      let draft: { service?: string; purpose?: string; envKey?: string };
      try {
        const p = JSON.parse(await readBody(req)) as { service?: unknown; purpose?: unknown; envKey?: unknown };
        draft = {
          ...(typeof p.service === "string" ? { service: p.service } : {}),
          ...(typeof p.purpose === "string" ? { purpose: p.purpose } : {}),
          ...(typeof p.envKey === "string" ? { envKey: p.envKey } : {}),
        };
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetchCap("POST", "/v1/keychain/drops", JSON.stringify(draft));
      return relay(res, r);
    }

    if (method === "DELETE" && path.startsWith("/api/keychain/credentials/")) {
      const id = decodeURIComponent(path.slice("/api/keychain/credentials/".length));
      if (!id) return json(res, 400, { error: "bad_request", message: "credential id required" });
      const r = await coreFetchCap("DELETE", `/v1/keychain/credentials/${encodeURIComponent(id)}`);
      return relay(res, r);
    }

    if (method === "GET" && path.startsWith("/api/deployments/") && path.endsWith("/owner-url")) {
      const id = decodeURIComponent(path.slice("/api/deployments/".length, -"/owner-url".length));
      if (!id || id.includes("/")) return json(res, 404, { error: "not_found" });
      const r = await coreFetch(
        "GET",
        `/v1/deployments/${encodeURIComponent(id)}/owner-url?principalId=${encodeURIComponent(user)}`,
      );
      return relay(res, r);
    }

    if (method === "GET" && path === "/api/deployments") {
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
    }

    if (method === "GET" && path.startsWith("/api/deployments/")) {
      const id = decodeURIComponent(path.slice("/api/deployments/".length));
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
    }

    if (method === "POST" && path.startsWith("/api/deployments/") && path.endsWith("/display-name")) {
      const id = decodeURIComponent(path.slice("/api/deployments/".length, -"/display-name".length));
      if (!(await gateManageDeployment(res, user, id))) return;
      let displayName: string;
      try {
        displayName = String((JSON.parse(await readBody(req)) as { displayName?: unknown }).displayName ?? "");
      } catch {
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch(
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/display-name`,
        JSON.stringify({ displayName }),
      );
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/deployments/") && path.endsWith("/name")) {
      const id = decodeURIComponent(path.slice("/api/deployments/".length, -"/name".length));
      if (!(await gateManageDeployment(res, user, id))) return;
      let name: string;
      try {
        name = String((JSON.parse(await readBody(req)) as { name?: unknown }).name ?? "");
      } catch {
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch("POST", `/v1/deployments/${encodeURIComponent(id)}/name`, JSON.stringify({ name }));
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/deployments/") && path.endsWith("/archive")) {
      const id = decodeURIComponent(path.slice("/api/deployments/".length, -"/archive".length));
      if (!(await gateManageDeployment(res, user, id))) return;
      const r = await coreFetch("POST", `/v1/deployments/${encodeURIComponent(id)}/archive`);
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/deployments/") && path.endsWith("/restore")) {
      const id = decodeURIComponent(path.slice("/api/deployments/".length, -"/restore".length));
      if (!(await gateManageDeployment(res, user, id))) return;
      const r = await coreFetch(
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/restore`,
        JSON.stringify({ principalId: user }),
      );
      return relay(res, r);
    }

    if (method === "POST" && path.startsWith("/api/approvals/")) {
      const requestId = decodeURIComponent(path.slice("/api/approvals/".length));
      if (!requestId || requestId.includes("/")) return json(res, 404, { error: "not_found" });
      let approved = false;
      let scope: "once" | "session" | "always" | undefined;
      try {
        const p = JSON.parse(await readBody(req)) as { approved?: unknown; scope?: unknown };
        approved = p.approved === true;
        if (p.scope === "once" || p.scope === "session" || p.scope === "always") scope = p.scope;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
      }

      const fetched = await coreFetch("GET", `/v1/approvals/${encodeURIComponent(requestId)}`);
      if (fetched.status !== 200) {
        res.writeHead(fetched.status, { "content-type": "application/json" });
        return res.end(fetched.text);
      }
      let record: CoreApprovalRecord;
      try {
        record = JSON.parse(fetched.text) as CoreApprovalRecord;
      } catch {
        return json(res, 502, { error: "bad_core_response" });
      }
      const threadRef =
        typeof record.request?.conversation?.threadRef === "string" ? record.request.conversation.threadRef : "";
      const actor = typeof record.request?.actor?.externalId === "string" ? record.request.actor.externalId : "";
      if (!threadRef.startsWith("web:") || actor !== user || !record.request) {
        return json(res, 404, { error: "not_found" });
      }
      if (!threadRef.startsWith(`web:${user}:`)) {
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
        const visible = sessionId
          ? await coreFetch("GET", `/v1/sessions/${encodeURIComponent(sessionId)}?viewer=${encodeURIComponent(user)}`)
          : null;
        if (visible?.status !== 200) return json(res, 404, { error: "not_found" });
      }

      const approval = { requestId, approved, ...(scope ? { scope } : {}) };
      return postTurnAndMint(res, { ...record.request, approval }, user, threadRef);
    }

    if (method === "POST" && path === "/api/turn") {
      const ownPrefix = `web:${user}:`;
      let text = "";
      let threadRef = `${ownPrefix}default`;
      let model: string | undefined;
      let harness: string | undefined;
      let thinkingLevel: string | undefined;
      let fastMode: boolean | undefined;
      let timezone: string | undefined;
      let scope: string | undefined;
      let channelName: string | undefined;
      const attachments: CoreAttachment[] = [];
      let approval: { requestId: string; approved: boolean; scope?: string } | undefined;
      let proactiveOpener = false;
      try {
        const p = JSON.parse(await readBody(req));
        text = String(p.text ?? "");
        if (p.proactiveOpener === true) proactiveOpener = true;
        if (p.approval && typeof p.approval.requestId === "string" && typeof p.approval.approved === "boolean") {
          approval = {
            requestId: p.approval.requestId,
            approved: p.approval.approved,
            ...(p.approval.scope === "once" || p.approval.scope === "session" || p.approval.scope === "always"
              ? { scope: p.approval.scope }
              : {}),
          };
        }
        if (typeof p.threadRef === "string" && p.threadRef.startsWith("web:")) threadRef = p.threadRef;
        if (typeof p.scopeId === "string" && p.scopeId) scope = p.scopeId;
        if (typeof p.channelName === "string" && p.channelName.trim()) channelName = p.channelName.trim().slice(0, 200);
        if (typeof p.model === "string" && p.model) model = p.model;
        if (typeof p.harness === "string") harness = p.harness;
        if (typeof p.thinkingLevel === "string") thinkingLevel = p.thinkingLevel;
        if (typeof p.fastMode === "boolean") fastMode = p.fastMode;
        if (typeof p.timezone === "string" && p.timezone.trim()) timezone = p.timezone.trim().slice(0, 64);
        if (Array.isArray(p.attachments)) {
          for (const raw of p.attachments as unknown[]) {
            if (!raw || typeof raw !== "object") continue;
            const a = raw as { name?: unknown; mimetype?: unknown; sizeBytes?: unknown; blobId?: unknown };
            if (typeof a.name !== "string" || typeof a.blobId !== "string" || !a.blobId) continue;
            attachments.push({
              name: a.name,
              mimetype: typeof a.mimetype === "string" && a.mimetype ? a.mimetype : "application/octet-stream",
              sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
              blobId: a.blobId,
            });
          }
        }
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
      }
      if (!text.trim() && attachments.length === 0 && !approval && !proactiveOpener)
        return json(res, 400, { error: "empty message" });

      if (!threadRef.startsWith(ownPrefix) && !(scope?.startsWith("channel:") || scope?.startsWith("group:"))) {
        return json(res, 403, {
          error: "forbidden_thread",
          message: "this conversation can only be continued from its own context",
        });
      }

      const conversation = conversationForScope(user, threadRef, scope, channelName);
      if (!conversation) {
        return json(res, 403, {
          error: "forbidden_scope",
          message: "you can only chat in your personal context or a shared context you're in",
        });
      }

      const displayName = resolveIdentity(req)?.name ?? null;
      const turn = {
        surface: "web",
        actor: { externalId: user, ...(displayName ? { displayName } : {}) },
        conversation,
        liveActor: true,
        deliveryTarget: threadRef,
        text,
        ...(harness ? { harness } : {}),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        ...(timezone ? { timezone } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(approval ? { approval } : {}),
        ...(proactiveOpener ? { proactiveOpener: true } : {}),
      };
      return postTurnAndMint(res, turn, user, threadRef);
    }

    if (method === "GET" && path === "/api/deliveries/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");
      let set = deliveryClients.get(user);
      if (!set) {
        set = new Set();
        deliveryClients.set(user, set);
      }
      set.add(res);
      const beat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
      beat.unref?.();
      req.on("close", () => {
        clearInterval(beat);
        const s = deliveryClients.get(user);
        if (s) {
          s.delete(res);
          if (!s.size) deliveryClients.delete(user);
        }
      });
      return;
    }

    if (method === "GET" && path === "/api/runs/active") {
      const threadRef = url.searchParams.get("threadRef") ?? "";
      if (!threadRef.startsWith("web:")) return json(res, 404, { error: "not_found" });
      const tryRun = async (runId: string, ownedByUser = true): Promise<boolean> => {
        const r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(runId)}`);
        if (r.status < 200 || r.status >= 300) {
          if (ownedByUser) forgetRun(runId);
          return false;
        }
        let run: { status?: string };
        try {
          run = JSON.parse(r.text) as { status?: string };
        } catch {
          json(res, 502, { error: "bad_core_response" });
          return true;
        }
        if (run.status === "done" || run.status === "failed") {
          forgetRun(runId);
          return false;
        }
        rememberRun(runId, user, threadRef);
        json(res, 200, { runId, run });
        return true;
      };
      for (const runId of Array.from(activeRunsByThread.get(threadKey(user, threadRef)) ?? [])) {
        if (await tryRun(runId)) return;
      }
      const d = await coreFetch("GET", `/v1/runs?threadRef=${encodeURIComponent(threadRef)}`);
      if (d.status >= 200 && d.status < 300) {
        let runId: string | null = null;
        try {
          runId = (JSON.parse(d.text) as { runId?: string | null }).runId ?? null;
        } catch {
          void 0;
        }
        if (runId && (await tryRun(runId, false))) return;
      }
      json(res, 200, { runId: null, run: null });
      return;
    }

    if (method === "POST" && path.startsWith("/api/runs/") && path.endsWith("/signal")) {
      const id = decodeURIComponent(path.slice("/api/runs/".length, -"/signal".length));
      let kind = "";
      let text: string | undefined;
      try {
        const p = JSON.parse(await readBody(req)) as { kind?: unknown; text?: unknown };
        if (typeof p.kind === "string") kind = p.kind;
        if (typeof p.text === "string") text = p.text;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request" });
      }
      const r = await coreFetch(
        "POST",
        `/v1/runs/${encodeURIComponent(id)}/signal`,
        JSON.stringify({ kind, ...(text !== undefined ? { text } : {}) }),
      );
      return relay(res, r);
    }

    if (method === "GET" && path.startsWith("/api/runs/") && path.endsWith("/events")) {
      const id = decodeURIComponent(path.slice("/api/runs/".length, -"/events".length));
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      if (!ownsRun(id, user)) {
        const auth = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
        if (auth.status < 200 || auth.status >= 300)
          return json(res, auth.status === 404 ? 404 : 502, {
            error: auth.status === 404 ? "not_found" : "upstream_error",
          });
      }
      if (closed) return;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");
      let acc = "";
      let activityLen = 0;
      let lastStale: boolean | null = null;
      let staleSince: number | null = null;
      let lastProgressAt = Date.now();
      let lastBeat = lastProgressAt;
      for (;;) {
        if (closed) return;
        let r: { status: number; text: string };
        try {
          r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
        } catch {
          try {
            r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
          } catch {
            sseEvent(res, "failed", { reason: "upstream_unreachable" });
            break;
          }
        }
        if (closed) return;
        if (r.status < 200 || r.status >= 300) {
          sseEvent(res, "failed", { reason: `HTTP ${r.status}` });
          break;
        }
        let run: {
          status?: string;
          result?: unknown;
          partial?: string;
          alive?: boolean;
          stale?: boolean;
          replyComplete?: boolean;
          activity?: unknown[];
          startedAt?: number | null;
          finishedAt?: number | null;
        } = {};
        let parsed = true;
        try {
          run = JSON.parse(r.text);
        } catch {
          parsed = false;
        }
        const now = Date.now();
        const partial = typeof run.partial === "string" ? run.partial : "";
        const activity = Array.isArray(run.activity) ? run.activity : [];
        if (partial.length > acc.length) {
          acc = partial;
          sseEvent(res, "partial", { partial: acc });
          lastProgressAt = now;
          lastBeat = now;
        }
        if (activity.length > activityLen) {
          activityLen = activity.length;
          sseEvent(res, "activity", { activity, startedAt: run.startedAt ?? null });
          lastProgressAt = now;
          lastBeat = now;
        }
        if (parsed) {
          if (run.stale === true) staleSince ??= now;
          else staleSince = null;
          if ((run.stale === true) !== lastStale) {
            lastStale = run.stale === true;
            sseEvent(res, "stale", { stale: lastStale });
            lastBeat = now;
          }
        }
        if (now - lastBeat > SSE_HEARTBEAT_MS) {
          if (run.alive === true) sseEvent(res, "alive", { at: now });
          else if (lastStale === true) sseEvent(res, "stale", { stale: true });
          else res.write(": ping\n\n");
          lastBeat = now;
        }
        if (run.alive === true || (staleSince !== null && now - staleSince < SSE_STALE_GRACE_MS)) lastProgressAt = now;
        const terminal = run.status === "done" || run.status === "failed" || run.result != null;
        if (terminal || run.replyComplete) {
          forgetRun(id);
          sseEvent(res, "done", {
            status: run.status ?? null,
            result: run.result ?? null,
            partial: acc,
            activity,
            replyComplete: run.replyComplete ?? false,
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
          });
          break;
        }
        if (now - lastProgressAt > SSE_IDLE_MS) break;
        await sleep(lastStale === true ? SSE_STALE_POLL_MS : SSE_CORE_POLL_MS);
      }
      if (!closed) res.end();
      return;
    }

    if (method === "GET" && path.startsWith("/api/runs/")) {
      const id = decodeURIComponent(path.slice("/api/runs/".length));
      const r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
      try {
        const s = (JSON.parse(r.text) as { status?: string }).status;
        if (s === "done" || s === "failed") forgetRun(id);
      } catch {
        void 0;
      }
      return relay(res, r);
    }

    if (path === "/api/crons" || path.startsWith("/api/crons/")) {
      if (method === "GET" && path === "/api/crons") {
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
      }

      if (method === "GET" && path.startsWith("/api/crons/") && path.endsWith("/runs")) {
        const id = decodeURIComponent(path.slice("/api/crons/".length, -"/runs".length));
        return relay(
          res,
          await coreFetch(
            "GET",
            `/v1/crons/${encodeURIComponent(id)}/runs?principalId=${encodeURIComponent(user)}&limit=20`,
          ),
        );
      }

      if (method === "PATCH" && path.startsWith("/api/crons/") && !path.slice("/api/crons/".length).includes("/")) {
        const id = decodeURIComponent(path.slice("/api/crons/".length));
        let patch: { title?: string; task?: string; schedule?: unknown; enabled?: boolean; archived?: boolean } = {};
        try {
          const p = JSON.parse(await readBody(req)) as {
            title?: unknown;
            task?: unknown;
            schedule?: unknown;
            enabled?: unknown;
            archived?: unknown;
          };
          if ("title" in p) {
            if (typeof p.title !== "string")
              return json(res, 400, { error: "bad_request", message: "title must be a string" });
            patch = { ...patch, title: p.title.trim() };
          }
          if ("task" in p) {
            if (typeof p.task !== "string" || !p.task.trim())
              return json(res, 400, { error: "bad_request", message: "task must be a non-empty string" });
            patch = { ...patch, task: p.task.trim() };
          }
          if ("schedule" in p) patch = { ...patch, schedule: p.schedule };
          if ("enabled" in p) {
            if (typeof p.enabled !== "boolean")
              return json(res, 400, { error: "bad_request", message: "enabled must be a boolean" });
            patch = { ...patch, enabled: p.enabled };
          }
          if ("archived" in p) {
            if (typeof p.archived !== "boolean")
              return json(res, 400, { error: "bad_request", message: "archived must be a boolean" });
            patch = { ...patch, archived: p.archived };
          }
        } catch (e) {
          if (e instanceof PayloadTooLargeError) throw e;
          return json(res, 400, { error: "bad_request", message: "expected JSON body" });
        }
        if (Object.keys(patch).length === 0)
          return json(res, 400, {
            error: "bad_request",
            message: "expected title, task, schedule, enabled, or archived",
          });
        if (patch.archived === true) patch = { ...patch, enabled: false };
        const r = await coreFetch(
          "PATCH",
          `/v1/crons/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
          JSON.stringify(patch),
        );
        return relay(res, r);
      }

      if (method === "POST" && path.endsWith("/disable")) {
        const id = decodeURIComponent(path.slice("/api/crons/".length, -"/disable".length));
        const r = await coreFetch(
          "POST",
          `/v1/crons/${encodeURIComponent(id)}/disable?principalId=${encodeURIComponent(user)}`,
        );
        return relay(res, r);
      }

      if (method === "POST" && path.endsWith("/enable")) {
        const id = decodeURIComponent(path.slice("/api/crons/".length, -"/enable".length));
        const r = await coreFetch(
          "PATCH",
          `/v1/crons/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
          JSON.stringify({ enabled: true, archived: false }),
        );
        return relay(res, r);
      }

      if (method === "POST" && path.endsWith("/run")) {
        const id = decodeURIComponent(path.slice("/api/crons/".length, -"/run".length));
        const r = await coreFetch(
          "POST",
          `/v1/crons/${encodeURIComponent(id)}/run?principalId=${encodeURIComponent(user)}`,
        );
        return relay(res, r);
      }

      if (method === "DELETE" && path.startsWith("/api/crons/") && !path.slice("/api/crons/".length).includes("/")) {
        const id = decodeURIComponent(path.slice("/api/crons/".length));
        const r = await coreFetch(
          "DELETE",
          `/v1/crons/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
        );
        return relay(res, r);
      }

      return json(res, 404, { error: "not found" });
    }

    return json(res, 404, { error: "not found" });
  }

  if (method === "GET" && path.startsWith("/deployments/")) {
    const user = cookieUser(req);
    if (!user) return json(res, 401, { error: "sign in", mode: AUTH_MODE });
    const rest = path.slice("/deployments/".length);
    const slash = rest.indexOf("/");
    const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const subPath = slash === -1 ? "/" : rest.slice(slash);
    const corePath = `/d/${encodeURIComponent(id)}${subPath}${url.search}`;
    const portalTok = portalTokenStore.getStore();
    const headers: Record<string, string> = {
      ...signedHeaders(CORE_SIGNING_SECRET, method, corePath, "", user),
      "x-as-principal": user,
      ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
    };
    delete headers["content-type"];
    const up = await fetch(`${CORE}${corePath}`, { method, headers, redirect: "manual" });
    const outHeaders = Object.fromEntries(up.headers.entries());
    delete outHeaders["content-encoding"];
    delete outHeaders["content-length"];
    res.writeHead(up.status, {
      ...outHeaders,
      "content-security-policy": UNTRUSTED_CONTENT_SANDBOX_CSP,
      "x-content-type-options": "nosniff",
    });
    return res.end(Buffer.from(await up.arrayBuffer()));
  }

  if (method === "GET" && path === "/app-edit" && (await serveAppEditHtml(req, res, url))) return;

  if (method === "GET") {
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

const server = createServer((req, res) => {
  void handler(req, res).catch((err: unknown) => {
    console.error(`[web-ui] 502 ${req.method ?? "?"} ${req.url ?? "?"}:`, err);
    if (!res.headersSent) json(res, 502, { error: "bad_gateway", message: "upstream error" });
    else res.end();
  });
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createVite(server)
    .then((v) => {
      vite = v;
      server.listen(PORT, () => {
        console.log(
          `[web-ui] surface on http://localhost:${PORT} → core ${CORE} (org ${ORG})${WEB_UI_DEV ? " [vite hmr]" : ""}`,
        );
        if (!WEB_UI_DEV && !existsSync(join(DIST, "index.html")))
          console.warn("[web-ui] dist-web/ not built — run `npm run build`");
        if (COOKIE_AUTH && ALLOW.length === 0)
          console.warn("[web-ui] WEB_UI_PRINCIPALS unset — any principal id may sign in (dev only)");
        const t = setInterval(() => void drainWebDeliveries(), WEB_DELIVERY_POLL_MS);
        t.unref?.();
        void runStateFeed();
      });
    })
    .catch((err: unknown) => {
      console.error("[web-ui] failed to start:", err);
      process.exit(1);
    });
}
