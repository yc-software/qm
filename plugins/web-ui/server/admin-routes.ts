import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchCoreText, relayCoreDownload, relayCoreStream, type HttpMethod } from "../../chassis/src/core-client.ts";
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
  uploadFile: (
    req: IncomingMessage,
    res: ServerResponse,
    sha256: string,
    name: string,
    register: { path: string; fields: Record<string, string>; headers: Record<string, string> },
  ) => Promise<void>;
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

  const download = (c: AdminCtx, corePath: string) =>
    relayCoreDownload(c.res, {
      origin: d.origin,
      secret: d.secret,
      path: corePath,
      headers: actorHeaders(c.user),
      copyHeaders: [
        "content-type",
        "content-length",
        "content-disposition",
        "x-content-type-options",
        "content-security-policy",
        "cache-control",
      ],
    });

  const upload = (c: AdminCtx) => {
    const scope = c.url.searchParams.get("scope") ?? "";
    if (!scope) {
      c.req.resume();
      return d.json(c.res, 400, { error: "bad_request", message: "scope required" });
    }
    return d.uploadFile(
      c.req,
      c.res,
      c.url.searchParams.get("sha") ?? "",
      c.url.searchParams.get("name")?.trim() || "file",
      {
        path: `/v1/admin/files/upload?scope=${encodeURIComponent(scope)}`,
        fields: {},
        headers: actorHeaders(c.user),
      },
    );
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
