import { orgId as configOrgId } from "../config.ts";
import { Readable } from "node:stream";
import { CREDENTIAL_BROKER_AUD, verifyCapabilityToken, type CapabilityClaims } from "../auth/capability-token.ts";
import { scopeId as makeScopeId } from "../types.ts";
import { type DecryptedServiceCredential, isValidCredentialSlug } from "../credentials/keychain.ts";
import { brokerCredentialAuthHeader, brokerPathAllowed } from "./credential-broker.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { headerValue, pipeToResponse, sendJson } from "./http.ts";
import type { BaseCtx } from "./routes/route.ts";
import { proxyHeaders } from "../util/http-proxy.ts";

export const GIT_HTTP_BROKER_PREFIX = "/v1/credentials/git/";

const ALLOWED_GIT_HEADERS = new Set(["accept", "content-length", "content-type", "git-protocol", "user-agent"]);

interface GitHttpFetchResponse {
  status: number;
  headers?: Record<string, string>;
  body?: NodeJS.ReadableStream | null;
}

export type GitHttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: NodeJS.ReadableStream },
) => Promise<GitHttpFetchResponse>;

const realGitHttpFetch: GitHttpFetch = async (url, init) => {
  const req: RequestInit & { duplex?: "half" } = {
    method: init.method,
    headers: init.headers,
    redirect: "manual",
    ...(init.body ? { body: init.body as unknown as RequestInit["body"], duplex: "half" as const } : {}),
  };
  const resp = await fetch(url, req);
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: resp.status,
    headers,
    body: resp.body ? Readable.fromWeb(resp.body as ReadableStream<Uint8Array>) : null,
  };
};

function parseBrokerPath(pathname: string): { slug: string; upstreamPath: string } | null {
  if (!pathname.startsWith(GIT_HTTP_BROKER_PREFIX)) return null;
  const rest = pathname.slice(GIT_HTTP_BROKER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  if (!isValidCredentialSlug(slug)) return null;
  const upstreamPath = `/${rest.slice(slash + 1)}`;
  if (upstreamPath === "/" || upstreamPath.includes("\0")) return null;
  return { slug, upstreamPath };
}

function callerHeaders(ctx: BaseCtx): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    const lower = key.toLowerCase();
    if (typeof value === "string" && ALLOWED_GIT_HEADERS.has(lower)) headers[lower] = value;
  }
  return headers;
}

function responseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return proxyHeaders(headers ?? {}, ["content-encoding", "content-length"]);
}

function capabilityFrom(ctx: BaseCtx): Promise<CapabilityClaims | null> {
  const token = headerValue(ctx.req, CAPABILITY_HEADER);
  const capSecret = ctx.deps.capabilitySecret ?? ctx.secret;
  return token && capSecret ? verifyCapabilityToken(token, capSecret) : Promise.resolve(null);
}

function recordDenied(ctx: BaseCtx, claims: CapabilityClaims | null, slug: string, host: string, code: string): void {
  if (!claims) return;
  ctx.deps.credentialUsage?.record({
    slug,
    host,
    status: "denied",
    scopeLabel: claims.scopeId,
    principalId: claims.actorId,
  });
  ctx.deps.auditLog?.record({
    at: Date.now(),
    principalId: claims.actorId,
    action: "credential.git.denied",
    resource: slug || "(none)",
    scopeLabel: claims.scopeId,
    status: "denied",
    detail: code,
  });
}

function sendDenied(
  ctx: BaseCtx,
  claims: CapabilityClaims | null,
  status: number,
  code: string,
  message: string,
  slug: string,
  host: string,
): void {
  recordDenied(ctx, claims, slug, host, code);
  sendJson(ctx.res, status, { error: code, message });
}

function gitUrlFor(rec: DecryptedServiceCredential, upstreamPath: string, search: string): URL {
  const upstream = new URL(`https://${rec.host}${upstreamPath}`);
  upstream.search = search;
  return upstream;
}

export async function brokerGitHttp(ctx: BaseCtx): Promise<void> {
  const parsed = parseBrokerPath(ctx.pathname);
  if (!parsed) return sendJson(ctx.res, 404, { error: "not_found" });
  const { slug, upstreamPath } = parsed;
  const method = ctx.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return sendJson(ctx.res, 405, { error: "method_not_allowed", message: "git smart HTTP supports GET and POST" });
  }
  if (!ctx.deps.serviceCreds) return sendJson(ctx.res, 404, { error: "not_found" });

  const claims = await capabilityFrom(ctx);
  if (!claims)
    return sendJson(ctx.res, 401, { error: "unauthorized", message: "credential-broker capability token required" });
  if (ctx.deps.identity) {
    await ctx.deps.identity.refresh();
    if (ctx.deps.identity.classify(claims.actorId).type !== "internal") {
      return sendJson(ctx.res, 401, { error: "unauthorized", message: "principal is no longer active" });
    }
  }
  if (claims.aud !== CREDENTIAL_BROKER_AUD) {
    return sendJson(ctx.res, 403, {
      error: "forbidden",
      message: "git credential broker requires a credential-broker capability token",
    });
  }
  if (
    !(await ctx.app.authorizesCapabilityScope({
      actorId: claims.actorId,
      scopeId: claims.scopeId,
      ...(claims.scopeVersion ? { scopeVersion: claims.scopeVersion } : {}),
      ...(claims.botActor ? { botActor: true } : {}),
      ...(claims.liveActor ? { liveActor: true } : {}),
      ...(claims.members ? { members: claims.members } : {}),
    }))
  ) {
    return sendJson(ctx.res, 403, { error: "forbidden", message: "capability scope membership has been revoked" });
  }
  if (!Array.isArray(claims.credentials) || !claims.credentials.includes(slug)) {
    return sendDenied(ctx, claims, 403, "not_entitled", "this session is not entitled to that credential", slug, "");
  }

  const orgScope = makeScopeId("org", configOrgId());
  const rec = await ctx.deps.serviceCreds.getServiceCredentialSecret(orgScope, slug);
  if (!rec || !rec.enabled || rec.delivery === "env") {
    return sendDenied(
      ctx,
      claims,
      404,
      "credential_unavailable",
      "credential not found or disabled",
      slug,
      rec?.host ?? "",
    );
  }
  const methods = (rec.allowedMethods && rec.allowedMethods.length ? rec.allowedMethods : ["GET"]).map((m) =>
    m.toUpperCase(),
  );
  if (!methods.includes(method)) {
    return sendDenied(
      ctx,
      claims,
      403,
      "method_not_allowed",
      `method ${method} is not allowed for this credential`,
      slug,
      rec.host,
    );
  }
  const upstream = gitUrlFor(rec, upstreamPath, ctx.url.search);
  if (!brokerPathAllowed(upstream.pathname, rec.allowedPathPrefixes)) {
    return sendDenied(
      ctx,
      claims,
      403,
      "path_not_allowed",
      "url path is not in the credential's allowlist",
      slug,
      rec.host,
    );
  }

  const headers = callerHeaders(ctx);
  const [authHeader, authValue] = brokerCredentialAuthHeader(rec);
  headers[authHeader] = authValue;

  let upstreamResp: GitHttpFetchResponse;
  try {
    upstreamResp = await (ctx.deps.gitHttpFetch ?? realGitHttpFetch)(upstream.toString(), {
      method,
      headers,
      ...(method === "POST" ? { body: ctx.req } : {}),
    });
  } catch {
    ctx.deps.credentialUsage?.record({
      slug,
      host: rec.host,
      status: "error",
      scopeLabel: claims.scopeId,
      principalId: claims.actorId,
    });
    ctx.deps.auditLog?.record({
      at: Date.now(),
      principalId: claims.actorId,
      action: "credential.git.error",
      resource: slug,
      scopeLabel: claims.scopeId,
      status: "error",
    });
    return sendJson(ctx.res, 502, {
      error: "upstream_unreachable",
      message: "the credential's host could not be reached",
    });
  }

  ctx.deps.credentialUsage?.record({
    slug,
    host: rec.host,
    status: "ok",
    upstreamStatus: upstreamResp.status,
    scopeLabel: claims.scopeId,
    principalId: claims.actorId,
  });
  ctx.deps.auditLog?.record({
    at: Date.now(),
    principalId: claims.actorId,
    action: "credential.git.use",
    resource: slug,
    scopeLabel: claims.scopeId,
    status: "ok",
  });
  ctx.res.writeHead(upstreamResp.status, responseHeaders(upstreamResp.headers));
  if (!upstreamResp.body) {
    ctx.res.end();
    return;
  }
  pipeToResponse(ctx.res, upstreamResp.body, "git upstream stream failed");
}
