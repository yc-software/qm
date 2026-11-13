import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { relayWebSocket, type UpgradeTarget } from "../../chassis/src/websocket-relay.ts";
import { signedHeaders } from "../../chassis/src/core-client.ts";
import { relayStream, withVary } from "../../chassis/src/http.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { CLIENT_SURFACE_HEADER } from "../../chassis/src/client-surface.ts";
import { REQUEST_ID_HEADERS } from "../../chassis/src/error-reporting.ts";

const IDENTITY_TTL_MS = 60_000;

const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
  "accept-encoding",
  "sec-fetch-dest",
  CLIENT_SURFACE_HEADER,
  ...REQUEST_ID_HEADERS,
];

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
  target: {
    protocol: string;
    hostname: string;
    port?: string;
    path: string;
    headers: Record<string, string | string[]>;
    forwardCookies?: boolean;
  },
): void {
  const headers = { ...target.headers };
  const length = req.headers["content-length"];
  if (length !== undefined) headers["content-length"] = length;
  else if (req.headers["transfer-encoding"] !== undefined) headers["transfer-encoding"] = "chunked";
  const up = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
    },
    (upRes) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        if (DROP_RESPONSE_HEADERS.has(k.toLowerCase()) && !(k.toLowerCase() === "set-cookie" && target.forwardCookies))
          continue;
        out[k] = v;
      }
      if (out.vary !== undefined) out.vary = withVary(res, String(out.vary));
      res.writeHead(upRes.statusCode ?? 502, out);
      relayStream(upRes, res);
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
  res.on("close", () => {
    if (!res.writableFinished) up.destroy();
  });
  relayStream(req, up);
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
  "linear-signature",
  "x-signature",
  "x-delivery-id",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
];

export const FORWARD_AGENT_API_HEADERS = [
  "content-type",
  "accept",
  "accept-encoding",
  "x-agent-capability",
  "x-content-sha256",
  "git-protocol",
];

export const FORWARD_DEPLOYMENT_LAYER_HEADERS = ["content-type", "accept", "x-timestamp", "x-signature"];

export const FORWARD_DEPLOYMENT_GIT_HEADERS = [
  "authorization",
  "content-type",
  "content-length",
  "content-encoding",
  "accept",
  "git-protocol",
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
  tenant?: string;
}

export function proxyToDeployment(req: IncomingMessage, res: ServerResponse, t: DeploymentTarget): void {
  const method = req.method ?? "GET";
  const corePath = `/d/${encodeURIComponent(t.id)}${t.subPath}${t.search}`;
  const core = new URL(t.coreBase);
  const signed = signedHeaders(t.signingSecret, method, corePath, "", t.principal);
  const base: Record<string, string> = { host: core.host, "x-as-principal": t.principal, ...signed };
  if (t.identitySecret)
    base[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
      { p: t.principal, ...(t.tenant ? { t: t.tenant } : {}), exp: Date.now() + IDENTITY_TTL_MS },
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
  forwardCookies?: boolean;
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
    ...(t.forwardCookies ? { forwardCookies: true } : {}),
    headers,
  });
}

export const FORWARD_BROKER_HEADERS = ["accept", "accept-language", "user-agent", "content-type"];

export const INTERNAL_HEADERS = [
  "x-signature",
  "x-timestamp",
  "x-as-principal",
  "x-admin-actor",
  "x-agent-capability",
  PORTAL_IDENTITY_HEADER,
  "x-qm-app-host",
  "x-qm-client-ip",
];

function appHostHeaders(
  req: IncomingMessage,
  clientIp: string | undefined,
  keep: readonly string[] = [],
): Record<string, string | string[]> {
  const blocked = new Set([
    ...DROP_RESPONSE_HEADERS,
    ...INTERNAL_HEADERS,
    "forwarded",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-for",
    ...(req.headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ]);
  for (const name of keep) blocked.delete(name);
  const headers: Record<string, string | string[]> = {
    "x-qm-app-host": "1",
    ...(clientIp ? { "x-qm-client-ip": clientIp } : {}),
  };
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !blocked.has(name)) headers[name] = value;
  }
  return headers;
}

export function proxyToAppHost(req: IncomingMessage, res: ServerResponse, coreBase: string, clientIp?: string): void {
  const upstream = new URL(coreBase);
  const headers = appHostHeaders(req, clientIp);
  res.removeHeader("x-frame-options");
  relay(req, res, {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: requestPort(upstream),
    path: req.url ?? "/",
    headers,
    forwardCookies: true,
  });
}

export function relayUpgradeToAppHost(
  req: IncomingMessage,
  res: ServerResponse,
  target: UpgradeTarget,
  coreBase: string,
  clientIp?: string,
): void {
  const upstream = new URL(coreBase);
  relayWebSocket(
    res,
    target,
    {
      tls: upstream.protocol === "https:",
      hostname: upstream.hostname,
      port: requestPort(upstream),
      path: req.url ?? "/",
      headers: appHostHeaders(req, clientIp, ["connection", "upgrade"]),
    },
    "portal-websocket",
  );
}
