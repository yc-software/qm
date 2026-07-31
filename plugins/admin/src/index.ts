import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { signedRequestHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { json, readBody, cookie } from "../../chassis/src/http.ts";
import { createBrandingCache, injectBranding, type OrgBranding } from "../../chassis/src/branding.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
  portFromEnv,
} from "../../chassis/src/env.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const PORT = portFromEnv(8090);
const ADMIN_BASE_PATH = (process.env.ADMIN_BASE_PATH ?? "").replace(/\/$/, "");
function signedHeaders(method: string, corePath: string, rawBody: string): Record<string, string> {
  return signedRequestHeaders(CORE_SIGNING_SECRET, method, corePath, rawBody, { "content-type": "application/json" });
}

const BASE_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../public/index.html"),
  "utf8",
).replaceAll("__ADMIN_BASE__", () => ADMIN_BASE_PATH);
const ADMIN_SCRIPT = BASE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
const ADMIN_CSP = [
  "default-src 'self'",
  `script-src 'sha256-${createHash("sha256").update(ADMIN_SCRIPT).digest("base64")}'`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

async function fetchBrand(): Promise<OrgBranding> {
  const corePath = withSourceAuthNonce("/v1/surface-config", CORE_SIGNING_SECRET);
  const r = await fetch(`${CORE}${corePath}`, {
    headers: signedHeaders("GET", corePath, ""),
    signal: AbortSignal.timeout(2_000),
  });
  if (!r.ok) throw new Error(`surface-config ${r.status}`);
  const b = ((await r.json()) as { branding?: Record<string, unknown> }).branding;
  return {
    ...(typeof b?.accent === "string" ? { accent: b.accent } : {}),
    ...(typeof b?.mark === "string" ? { mark: b.mark } : {}),
    ...(typeof b?.selfLabel === "string" ? { selfLabel: b.selfLabel } : {}),
  };
}
const brandCache = createBrandingCache(fetchBrand);
async function refreshBrandNow(): Promise<void> {
  await brandCache.refreshNow();
  shellCache = null;
}
let shellCache: { key: string; html: string; gzip: Buffer; etag: string } | null = null;
function brandedShell(branding: OrgBranding): { html: string; gzip: Buffer; etag: string } {
  const key = JSON.stringify([branding.accent, branding.mark, branding.selfLabel]);
  if (shellCache?.key === key) return shellCache;
  const html = injectBranding(BASE_HTML, branding);
  shellCache = {
    key,
    html,
    gzip: gzipSync(html),
    etag: `"${createHash("sha256").update(html).digest("hex").slice(0, 16)}"`,
  };
  return shellCache;
}
const ALLOW_UNSIGNED_TEST_IDENTITY =
  process.env.NODE_ENV === "test" && process.env.ALLOW_UNSIGNED_TEST_IDENTITY === "1";

function acceptsGzip(req: IncomingMessage): boolean {
  const ae = req.headers["accept-encoding"];
  return typeof ae === "string" && /\bgzip\b/.test(ae);
}

const cookiePrincipal = (req: IncomingMessage): string | null => {
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const principal =
    token && PORTAL_IDENTITY_SECRET ? verifyPortalIdentity(token, PORTAL_IDENTITY_SECRET, Date.now())?.p : null;
  return principal ?? (!CORE_SIGNING_SECRET || ALLOW_UNSIGNED_TEST_IDENTITY ? cookie(req, "admin") : null);
};

const portalTokenStore = new AsyncLocalStorage<string | undefined>();
function portalIdentityHeader(): Record<string, string> {
  const t = portalTokenStore.getStore();
  return t ? { [PORTAL_IDENTITY_HEADER]: t } : {};
}

function pipeBody(res: ServerResponse, body: Response["body"]): void {
  if (!body) return void res.end();
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("error", () => res.destroy());
  res.on("close", () => {
    if (!res.writableFinished) stream.destroy();
  });
  return void stream.pipe(res);
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  principal: string,
  method: "GET" | "PUT" | "POST" | "DELETE" | "PATCH",
  corePath: string,
  body?: string,
): Promise<void> {
  try {
    const r = await fetch(`${CORE}${corePath}`, {
      method,
      headers: {
        ...signedHeaders(method, corePath, body ?? ""),
        "x-admin-actor": `${principal}@${ORG}`,
        ...portalIdentityHeader(),
      },
      ...(body ? { body } : {}),
    });
    if (r.body && acceptsGzip(req)) {
      res.writeHead(r.status, { "content-type": "application/json", "content-encoding": "gzip" });
      const src = Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]);
      const gz = createGzip();
      src.on("error", () => res.destroy());
      gz.on("error", () => res.destroy());
      res.on("close", () => {
        if (!res.writableFinished) {
          src.destroy();
          gz.destroy();
        }
      });
      src.pipe(gz).pipe(res);
      return;
    }
    res.writeHead(r.status, { "content-type": "application/json" });
    pipeBody(res, r.body);
  } catch (err) {
    console.error("[admin] core request failed:", String(err));
    json(res, 502, { error: "core_unreachable", message: "core unavailable" });
  }
}

async function forwardDownload(res: ServerResponse, principal: string, corePath: string): Promise<void> {
  try {
    const r = await fetch(`${CORE}${corePath}`, {
      method: "GET",
      headers: {
        ...signedHeaders("GET", corePath, ""),
        "x-admin-actor": `${principal}@${ORG}`,
        ...portalIdentityHeader(),
      },
    });
    if (!r.ok || !r.body) {
      const text = await r.text();
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      return void res.end(text);
    }
    const headers: Record<string, string> = {};
    for (const name of [
      "content-type",
      "content-length",
      "content-disposition",
      "x-content-type-options",
      "content-security-policy",
      "cache-control",
    ]) {
      const value = r.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(r.status, headers);
    pipeBody(res, r.body);
  } catch (err) {
    console.error("[admin] core download failed:", String(err));
    json(res, 502, { error: "core_unreachable", message: "core unavailable" });
  }
}

function uploadFileName(req: IncomingMessage): string {
  const raw = typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : "";
  try {
    return decodeURIComponent(raw) || "file";
  } catch {
    return raw || "file";
  }
}

async function stageUploadStream(req: IncomingMessage, sha256: string): Promise<Response> {
  const corePath = withSourceAuthNonce("/v1/blobs", CORE_SIGNING_SECRET);
  const headers = signedRequestHeaders(CORE_SIGNING_SECRET, "POST", corePath, sha256, {
    "content-type": "application/octet-stream",
    "x-content-sha256": sha256,
  });
  return fetch(`${CORE}${corePath}`, {
    method: "POST",
    headers,
    body: req as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function uploadFileFromRequest(
  req: IncomingMessage,
  res: ServerResponse,
  principal: string,
  scope: string,
): Promise<void> {
  if (!scope) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "scope required" });
  }
  const sha256 = typeof req.headers["x-content-sha256"] === "string" ? req.headers["x-content-sha256"] : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "x-content-sha256 required" });
  }
  try {
    const staged = await stageUploadStream(req, sha256);
    const stagedText = await staged.text();
    if (!staged.ok) {
      res.writeHead(staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" });
      return void res.end(stagedText);
    }
    const { blobId } = JSON.parse(stagedText) as { blobId: string };
    const corePath = `/v1/admin/files/upload?scope=${encodeURIComponent(scope)}`;
    const body = JSON.stringify({
      name: uploadFileName(req),
      mimetype:
        typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
      blobId,
    });
    return forward(req, res, principal, "POST", corePath, body);
  } catch (err) {
    console.error("[admin] upload failed:", String(err));
    return json(res, 502, { error: "core_unreachable", message: "core unavailable" });
  }
}

async function coreWhoami(principal: string): Promise<{ isAdmin: boolean; role?: string; scopeId?: string } | null> {
  const corePath = "/v1/admin/whoami";
  try {
    const r = await fetch(`${CORE}${corePath}`, {
      headers: {
        ...signedHeaders("GET", corePath, ""),
        ...portalIdentityHeader(),
        "x-admin-actor": `${principal}@${ORG}`,
      },
    });
    if (!r.ok) return null;
    return (await r.json()) as { isAdmin: boolean; role?: string; scopeId?: string };
  } catch {
    return null;
  }
}

const WRITES = new Map<string, string[]>([
  ["grants", ["POST", "DELETE"]],
  ["memory", ["PUT"]],
  ["crons", ["PUT"]],
  ["skills", ["DELETE"]],
  ["skill-packs", ["POST", "PATCH", "DELETE"]],
  ["users", ["PUT", "POST"]],
  ["slack-installation", ["PUT", "DELETE"]],
  ["model-providers", ["PUT", "DELETE"]],
  ["custom-providers", ["PUT", "DELETE"]],
]);

const READS = [
  "metrics",
  "egress",
  "errors",
  "audit",
  "crons",
  "deployments",
  "skills",
  "skill-packs",
  "sessions",
  "runs",
  "files",
  "retention",
  "users",
  "directory",
  "keychain",
  "memory",
  "slack-mirror",
  "ambient-judgments",
  "ack-emoji-picks",
  "slack-installation",
  "model-providers",
  "custom-providers",
];

const server = createServer((req, res) => {
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  void portalTokenStore
    .run(token, () => handle(req, res))
    .catch((err: unknown) => {
      console.error("[admin] unhandled request error:", String(err));
      json(res, 500, { error: "internal_error", message: "internal server error" });
    });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", ADMIN_CSP);
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  const serveShell = async (): Promise<void> => {
    const shell = brandedShell(await brandCache.forRender());
    if (req.headers["if-none-match"] === shell.etag) {
      res.writeHead(304, { etag: shell.etag, "cache-control": "no-cache" });
      return void res.end();
    }
    const gz = acceptsGzip(req);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      etag: shell.etag,
      "cache-control": "no-cache",
      ...(gz ? { "content-encoding": "gzip" } : {}),
    });
    return void res.end(gz ? shell.gzip : shell.html);
  };
  if (method === "GET" && pathname === "/") return serveShell();
  if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });

  if (method === "GET" && (pathname === "/api/me" || pathname === "/api/whoami")) {
    const p = cookiePrincipal(req);
    if (!p) return json(res, 401, { error: "signed_out" });
    const who = await coreWhoami(p);
    if (!who) return json(res, 502, { error: "core_unreachable", message: "could not verify admin status" });
    return json(res, 200, { principal: p, org: ORG, ...who });
  }
  if (method === "POST" && pathname === "/api/logout") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
    });
    return void res.end(JSON.stringify({ ok: true }));
  }

  const principal = cookiePrincipal(req);
  if (method === "GET" && pathname === "/api/scopes") {
    if (!principal) return json(res, 401, { error: "signed_out" });
    return forward(req, res, principal, "GET", "/v1/admin/scopes");
  }
  if (method === "GET" && pathname === "/api/resources") {
    if (!principal) return json(res, 401, { error: "signed_out" });
    return forward(req, res, principal, "GET", "/v1/admin/resources");
  }
  if (method === "GET" && pathname === "/api/connector-catalog") {
    if (!principal) return json(res, 401, { error: "signed_out" });
    return forward(req, res, principal, "GET", "/v1/connectors/catalog");
  }
  if (pathname.startsWith("/api/scopes/")) {
    if (!principal) return json(res, 401, { error: "signed_out" });
    const rest = pathname.slice("/api/scopes/".length);
    if (method === "GET") {
      if (rest.endsWith("/export")) {
        const scopeId = decodeURIComponent(rest.slice(0, -"/export".length));
        return forward(
          req,
          res,
          principal,
          "GET",
          `/v1/admin/scopes/${encodeURIComponent(scopeId)}/export${url.search}`,
        );
      }
      const scopeId = decodeURIComponent(rest);
      return forward(req, res, principal, "GET", `/v1/admin/scopes/${encodeURIComponent(scopeId)}`);
    }
    if (method === "PUT") {
      const slash = rest.lastIndexOf("/");
      if (slash <= 0) return json(res, 404, { error: "bad_path" });
      const scope = decodeURIComponent(rest.slice(0, slash));
      const resource = rest.slice(slash + 1);
      const corePath = `/v1/admin/scopes/${encodeURIComponent(scope)}/${resource}`;
      const putBody = await readBody(req);
      if (resource !== "branding") return forward(req, res, principal, "PUT", corePath, putBody);
      try {
        const r = await fetch(`${CORE}${corePath}`, {
          method: "PUT",
          headers: {
            ...signedHeaders("PUT", corePath, putBody),
            "x-admin-actor": `${principal}@${ORG}`,
            ...portalIdentityHeader(),
          },
          body: putBody,
        });
        const text = await r.text();
        if (r.ok) await refreshBrandNow();
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(text);
      } catch (err) {
        console.error("[admin] core request failed:", String(err));
        json(res, 502, { error: "core_unreachable", message: "core unavailable" });
      }
      return;
    }
  }

  const rest = pathname.startsWith("/api/") ? pathname.slice("/api/".length) : "";
  const first = rest.split("/")[0] ?? "";

  if (method === "GET" && pathname === "/api/files/download") {
    if (!principal) return json(res, 401, { error: "signed_out" });
    return forwardDownload(res, principal, `/v1/admin/files/download${url.search}`);
  }

  if (method === "POST" && pathname === "/api/files/upload") {
    if (!principal) {
      req.resume();
      return json(res, 401, { error: "signed_out" });
    }
    return uploadFileFromRequest(req, res, principal, url.searchParams.get("scope") ?? "");
  }

  if (WRITES.get(first)?.includes(method)) {
    if (!principal) return json(res, 401, { error: "signed_out" });
    const m = method as "POST" | "PUT" | "PATCH" | "DELETE";
    const corePath = `/v1/admin/${rest}${url.search}`;
    return m === "DELETE"
      ? forward(req, res, principal, m, corePath)
      : forward(req, res, principal, m, corePath, await readBody(req));
  }

  if (method === "GET" && READS.includes(first)) {
    if (!principal) return json(res, 401, { error: "signed_out" });
    return forward(req, res, principal, "GET", `/v1/admin/${rest}${url.search}`);
  }

  if (method === "GET" && !pathname.startsWith("/api/") && !pathname.startsWith("/deployments/")) {
    return serveShell();
  }

  json(res, 404, { error: "not_found" });
}

export function startServer(): void {
  server.listen(PORT, () => {
    console.log(`[admin-plugin] http://localhost:${PORT}  → core ${CORE} (org=${ORG})`);
    console.warn(
      "[admin-plugin] trusting the portal-synthesized admin cookie as identity — this app MUST stay private (no public http_service); reachable only through the private portal service.",
    );
  });
}

export { handle, server };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
