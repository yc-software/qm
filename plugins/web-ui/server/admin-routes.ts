import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  fetchCoreText,
  relayCoreStream,
  signedHeaders,
  withSourceAuthNonce,
  type HttpMethod,
} from "../../chassis/src/core-client.ts";
import { reportBackendError } from "../../chassis/src/error-reporting.ts";

interface AdminCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: string;
}

interface AdminRouteDeps {
  origin: string;
  secret: string | undefined;
  org: string;
  portalHeaders: () => Record<string, string>;
  impersonated: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
  stageUpload: (req: IncomingMessage, sha256: string) => Promise<Response>;
  refreshBranding: () => Promise<void>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

const PREFIX = "/api/admin/";

const ALLOWED: Record<string, string> = {
  whoami: "GET",
  scopes: "GET",
  resources: "GET",
  spend: "GET",
  egress: "GET",
  errors: "GET",
  audit: "GET",
  deployments: "GET",
  sessions: "GET",
  runs: "GET",
  files: "GET",
  retention: "GET",
  directory: "GET",
  keychain: "GET",
  "slack-mirror": "GET",
  "ambient-judgments": "GET",
  "ack-emoji-picks": "GET",
  "slack-emoji": "GET",
  grants: "POST DELETE",
  "external-users": "POST DELETE",
  "principal-links": "GET POST DELETE",
  memory: "GET POST PATCH DELETE",
  crons: "GET PUT",
  skills: "GET DELETE",
  "skill-packs": "GET POST PATCH DELETE",
  users: "GET PUT POST",
  "slack-installation": "GET POST PUT DELETE",
  "model-providers": "GET PUT DELETE",
  "model-registry": "GET POST PUT DELETE",
  "custom-providers": "GET PUT DELETE",
  "mcp-servers": "GET PUT DELETE",
};

export function adminRoutes(d: AdminRouteDeps) {
  const actorHeaders = (user: string) => ({ "x-admin-actor": `${user}@${d.org}`, ...d.portalHeaders() });

  const relay = (c: AdminCtx, method: HttpMethod, corePath: string, body = "") =>
    relayCoreStream(c.res, {
      origin: d.origin,
      secret: d.secret,
      method,
      path: corePath,
      body,
      headers: actorHeaders(c.user),
    });

  const download = async (c: AdminCtx, corePath: string) => {
    const path = withSourceAuthNonce(corePath, d.secret);
    const upstream = await fetch(`${d.origin}${path}`, {
      headers: { ...signedHeaders(d.secret, "GET", path, ""), ...actorHeaders(c.user) },
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    for (const name of [
      "content-type",
      "content-length",
      "content-disposition",
      "x-content-type-options",
      "content-security-policy",
      "cache-control",
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    c.res.writeHead(upstream.status, headers);
    if (!upstream.body) return c.res.end();
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on("error", () => c.res.destroy());
    c.res.on("close", () => stream.destroy());
    stream.pipe(c.res);
  };

  const upload = async (c: AdminCtx) => {
    const scope = c.url.searchParams.get("scope") ?? "";
    const sha256 = c.url.searchParams.get("sha") ?? "";
    if (!scope || !/^[0-9a-f]{64}$/.test(sha256)) {
      c.req.resume();
      return d.json(c.res, 400, {
        error: "bad_request",
        message: scope ? "sha (hex sha-256) required" : "scope required",
      });
    }
    const staged = await d.stageUpload(c.req, sha256);
    const stagedText = await staged.text();
    if (!staged.ok) {
      c.res.writeHead(staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" });
      return c.res.end(stagedText);
    }
    const body = JSON.stringify({
      name: c.url.searchParams.get("name")?.trim() || "file",
      mimetype:
        typeof c.req.headers["content-type"] === "string" ? c.req.headers["content-type"] : "application/octet-stream",
      blobId: (JSON.parse(stagedText) as { blobId: string }).blobId,
    });
    return relay(c, "POST", `/v1/admin/files/upload?scope=${encodeURIComponent(scope)}`, body);
  };

  const handle = async (c: AdminCtx): Promise<unknown> => {
    if (d.impersonated(c.req))
      return d.json(c.res, 403, { message: "Admin pages are unavailable while impersonating." });
    const method = c.req.method ?? "GET";
    const rest = c.url.pathname.slice(PREFIX.length);
    const first = rest.split("/")[0] ?? "";
    const corePath = `/v1/admin/${rest}${c.url.search}`;
    if (method === "GET" && rest === "connector-catalog") return relay(c, "GET", "/v1/connectors/catalog");
    if (method === "GET" && rest === "files/download") return download(c, corePath);
    if (method === "GET" && rest === "spend" && c.url.searchParams.get("format") === "csv")
      return download(c, corePath);
    if (method === "POST" && rest === "files/upload") return upload(c);
    if (first === "scopes" && rest.length > "scopes/".length) {
      if (method === "GET") return relay(c, "GET", corePath);
      if (method === "PUT" && rest.lastIndexOf("/") > "scopes/".length) {
        const body = await d.readBody(c.req);
        if (!rest.endsWith("/branding")) return relay(c, "PUT", corePath, body);
        const saved = await fetchCoreText({
          origin: d.origin,
          secret: d.secret,
          method: "PUT",
          path: corePath,
          body,
          headers: actorHeaders(c.user),
        });
        if (saved.status < 300) await d.refreshBranding().catch((err: unknown) => reportBackendError(err));
        c.res.writeHead(saved.status, { "content-type": "application/json", "x-content-type-options": "nosniff" });
        return c.res.end(saved.text);
      }
    }
    if (Object.hasOwn(ALLOWED, first) && ALLOWED[first]!.split(" ").includes(method)) {
      const body = method === "GET" || method === "DELETE" ? "" : await d.readBody(c.req);
      return relay(c, method as HttpMethod, corePath, body);
    }
    c.req.resume();
    return d.json(c.res, 404, { error: "not_found" });
  };

  return [{ match: (_method: string, pathname: string) => pathname.startsWith(PREFIX), handle }];
}
