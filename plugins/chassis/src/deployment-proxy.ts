import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { signedHeaders } from "./core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "./portal-identity.ts";

export function isDeploymentPath(path: string): boolean {
  return /^\/(?:d|deployments)(?:\/|$)/.test(path);
}

export function deploymentPath(path: string): { id: string; subPath: string } | null {
  const match = /^\/(?:d|deployments)\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    if (!id || /[\\/\x00-\x1f]/.test(id) || id === "." || id === "..") return null;
    return { id, subPath: match[2] || "/" };
  } catch {
    return null;
  }
}

export interface DeploymentTarget {
  coreBase: string;
  id: string;
  subPath: string;
  search: string;
  principal: string;
  signingSecret: string | undefined;
  identitySecret?: string;
  identityToken?: string;
  launchOrigin?: string;
}

const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "accept-encoding",
  "content-type",
  "content-length",
  "user-agent",
  "sec-fetch-dest",
  "range",
  "if-none-match",
  "if-modified-since",
];
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "set-cookie",
  "strict-transport-security",
];

export function proxyToDeployment(req: IncomingMessage, res: ServerResponse, target: DeploymentTarget): void {
  const core = new URL(target.coreBase);
  const method = req.method ?? "GET";
  const path = `/d/${encodeURIComponent(target.id)}${target.subPath}${target.search}`;
  const headers: Record<string, string> = {
    host: core.host,
    ...signedHeaders(target.signingSecret, method, path, "", target.principal),
    "x-as-principal": target.principal,
  };
  delete headers["content-type"];
  const hopHeaders = new Set(
    String(req.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  if (hopHeaders.has("content-length") && req.headers["content-length"] !== undefined) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_request_framing" }));
    return;
  }
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && !hopHeaders.has(name)) headers[name] = value;
  }
  const identity =
    target.identityToken ??
    (target.identitySecret
      ? mintPortalIdentity({ p: target.principal, exp: Date.now() + 60_000 }, target.identitySecret)
      : undefined);
  if (identity) headers[PORTAL_IDENTITY_HEADER] = identity;
  if (target.launchOrigin) headers["x-qm-launch-origin"] = target.launchOrigin;
  const upstream = (core.protocol === "https:" ? httpsRequest : httpRequest)(
    { protocol: core.protocol, hostname: core.hostname, port: core.port || undefined, method, path, headers },
    (response) => {
      upstream.setTimeout(0);
      const drop = new Set([
        ...HOP_HEADERS,
        ...String(response.headers.connection ?? "")
          .split(",")
          .map((x) => x.trim().toLowerCase()),
      ]);
      const out = Object.fromEntries(
        Object.entries(response.headers).filter(
          ([name, value]) => value !== undefined && !drop.has(name.toLowerCase()),
        ),
      );
      const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
      const existing = out["content-security-policy"];
      out["content-security-policy"] = existing
        ? [sandbox, ...(Array.isArray(existing) ? existing : [existing])]
        : sandbox;
      out["x-content-type-options"] = "nosniff";
      res.writeHead(response.statusCode ?? 502, out);
      response.on("error", () => res.destroy());
      response.pipe(res);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("deployment gateway response timed out")));
  upstream.on("error", () => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad_gateway", message: "deployment gateway unavailable" }));
  });
  req.on("error", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}
