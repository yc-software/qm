import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { signedHeaders } from "../../chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const IDENTITY_TTL_MS = 60_000;

const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "accept-language", "user-agent", "accept-encoding"];

const DROP_RESPONSE_HEADERS = new Set([
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
]);

function safeForwardHeaders(req: IncomingMessage, base: Record<string, string>): Record<string, string> {
  const headers = { ...base };
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  return headers;
}

export function requestPort(upstream: URL): string | undefined {
  return upstream.port || undefined;
}

function relay(
  req: IncomingMessage,
  res: ServerResponse,
  target: { protocol: string; hostname: string; port?: string; path: string; headers: Record<string, string> },
): void {
  const up = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.path,
      headers: target.headers,
    },
    (upRes) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        out[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.on("error", () => res.destroy());
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway", message: "upstream unreachable" }));
    } else {
      res.end();
    }
  });
  req.on("error", () => up.destroy());
  res.on("close", () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}

export interface SurfaceTarget {
  upstreamBase: string;
  forwardPath: string;
  search: string;
  cookieName: string;
  principal: string;
  displayName?: string;
  impersonator?: string;
  identitySecret?: string;
  nowMs?: number;
}

export function proxyToSurface(req: IncomingMessage, res: ServerResponse, t: SurfaceTarget): void {
  const upstream = new URL(t.upstreamBase);
  const cookie =
    `${t.cookieName}=${encodeURIComponent(t.principal)}` +
    (t.displayName ? `; ${t.cookieName}_name=${encodeURIComponent(t.displayName)}` : "") +
    (t.impersonator ? `; webui_impersonator=${encodeURIComponent(t.impersonator)}` : "");
  const base: Record<string, string> = { host: upstream.host, cookie };
  if (t.identitySecret) {
    const now = t.nowMs ?? Date.now();
    base[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
      {
        p: t.principal,
        ...(t.displayName ? { n: t.displayName } : {}),
        ...(t.impersonator ? { imp: t.impersonator } : {}),
        exp: now + IDENTITY_TTL_MS,
      },
      t.identitySecret,
    );
  }
  const headers = safeForwardHeaders(req, base);
  relay(req, res, {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: requestPort(upstream),
    path: `${t.forwardPath}${t.search}`,
    headers,
  });
}

export const FORWARD_WEBHOOK_HEADERS = [
  "content-type",
  "x-hub-signature-256",
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "stripe-signature",
  "x-signature",
  "x-delivery-id",
];

export const FORWARD_AGENT_API_HEADERS = [
  "content-type",
  "content-length",
  "accept",
  "x-agent-capability",
  "x-content-sha256",
  "git-protocol",
];

export const FORWARD_DEPLOYMENT_LAYER_HEADERS = [
  "content-type",
  "content-length",
  "accept",
  "x-timestamp",
  "x-signature",
];

export const FORWARD_OAUTH_HEADERS = ["accept", "accept-language", "user-agent", "content-type"];

export interface DeploymentTarget {
  coreBase: string;
  id: string;
  subPath: string;
  search: string;
  principal: string;
  signingSecret: string | undefined;
  identitySecret?: string;
}

export function proxyToDeployment(req: IncomingMessage, res: ServerResponse, t: DeploymentTarget): void {
  const method = req.method ?? "GET";
  const corePath = `/d/${encodeURIComponent(t.id)}${t.subPath}${t.search}`;
  const core = new URL(t.coreBase);
  const signed = signedHeaders(t.signingSecret, method, corePath, "", t.principal);
  const base: Record<string, string> = { host: core.host, "x-as-principal": t.principal, ...signed };
  if (t.identitySecret)
    base[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
      { p: t.principal, exp: Date.now() + IDENTITY_TTL_MS },
      t.identitySecret,
    );
  const headers = safeForwardHeaders(req, base);
  delete headers["content-type"];
  const ct = req.headers["content-type"];
  if (typeof ct === "string") headers["content-type"] = ct;
  relay(req, res, {
    protocol: core.protocol,
    hostname: core.hostname,
    port: requestPort(core),
    path: corePath,
    headers,
  });
}

export interface UpstreamTarget {
  baseUrl: string;
  path: string;
  search: string;
}

export function proxyToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  t: UpstreamTarget,
  forwardHeaders: readonly string[],
  extraHeaders: Record<string, string> = {},
): void {
  const upstream = new URL(t.baseUrl);
  const headers: Record<string, string> = { host: upstream.host };
  for (const h of forwardHeaders) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  Object.assign(headers, extraHeaders, { host: upstream.host });
  relay(req, res, {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: requestPort(upstream),
    path: `${t.path}${t.search}`,
    headers,
  });
}

export const FORWARD_BROKER_HEADERS = ["accept", "accept-language", "user-agent", "content-type", "content-length"];
