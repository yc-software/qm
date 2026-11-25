import { orgId as configOrgId } from "../config.ts";
import { Readable } from "node:stream";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import { personalScope, scopeId as makeScopeId } from "../types.ts";
import {
  credentialHandle,
  type DecryptedServiceCredential,
  type Keychain,
  isValidCredentialSlug,
  isComposioHost,
} from "../credentials/keychain.ts";
import {
  isPersonalCredentialHandle,
  personalGitBasicCredential,
  personalGitRemote,
} from "../credentials/personal-git.ts";
import {
  brokerPathAllowed,
  brokerRequestHeaders,
  grantedCredential,
  type CredentialGrant,
} from "./credential-broker.ts";
import { sendJson } from "./http.ts";
import { relayStream } from "../../plugins/chassis/src/http.ts";
import { tenantOf, type BaseCtx } from "./routes/route.ts";
import { proxyHeaders } from "../util/http-proxy.ts";

export const GIT_HTTP_BROKER_PREFIX = "/v1/credentials/git/";

const ALLOWED_GIT_HEADERS = new Set([
  "accept",
  "content-encoding",
  "content-length",
  "content-type",
  "git-protocol",
  "user-agent",
]);

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
  if (!isValidCredentialSlug(slug) && !isPersonalCredentialHandle(slug)) return null;
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

function recordDenied(ctx: BaseCtx, claims: CapabilityClaims, slug: string, host: string, code: string): void {
  ctx.deps.credentialUsage?.record(tenantOf(ctx), {
    slug,
    host,
    status: "denied",
    scopeLabel: claims.scopeId,
    principalId: claims.actorId,
  });
  ctx.deps.auditLog?.record(tenantOf(ctx), {
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
  claims: CapabilityClaims,
  status: number,
  code: string,
  message: string,
  slug: string,
  host: string,
): void {
  recordDenied(ctx, claims, slug, host, code);
  sendJson(ctx.res, status, { error: code, message });
}

const personalUnavailable = (host = ""): CredentialGrant => ({
  status: 404,
  code: "credential_unavailable",
  message: "credential not found or disabled",
  host,
});

async function grantedPersonalGitCredential(
  claims: CapabilityClaims,
  handle: string,
  keychain: Keychain | undefined,
): Promise<CredentialGrant> {
  if (!Array.isArray(claims.credentials) || !claims.credentials.includes(handle))
    return { status: 403, code: "not_entitled", message: "this session is not entitled to that credential", host: "" };
  if (claims.deployment)
    return {
      status: 403,
      code: "not_available_to_deployments",
      message: "personal credentials are not available to published apps",
      host: "",
    };
  if (!keychain) return personalUnavailable();
  const credential = (await keychain.listByOwner(claims.actorId)).find((c) => credentialHandle(c) === handle);
  const remote = credential && personalGitRemote(credential);
  if (!credential || !remote) return personalUnavailable();
  let secret: string | undefined;
  try {
    const materialized = await keychain.materializeOwnById(
      claims.actorId,
      credential.id,
      personalScope(claims.actorId),
    );
    if (materialized.kind === "env") secret = materialized.env.find((entry) => entry.key === credential.envKey)?.value;
  } catch {
    return personalUnavailable(remote.host);
  }
  if (!secret) return personalUnavailable(remote.host);
  return {
    rec: {
      slug: handle,
      name: credential.service,
      secret: personalGitBasicCredential(remote, secret),
      delivery: "broker",
      host: remote.host,
      injection: { scheme: "Basic " },
      allowedMethods: ["GET", "POST"],
      deployments: false,
      enabled: true,
    },
  };
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
  const personal = isPersonalCredentialHandle(slug);
  const serviceCreds = ctx.deps.serviceCreds;
  if (!personal && !serviceCreds) return sendJson(ctx.res, 404, { error: "not_found" });

  const claims = ctx.capability;
  if (!claims) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const grant =
    personal || !serviceCreds
      ? await grantedPersonalGitCredential(claims, slug, ctx.deps.keychain)
      : await grantedCredential(claims, slug, serviceCreds, makeScopeId("org", configOrgId()));
  if (!grant.rec) return sendDenied(ctx, claims, grant.status, grant.code, grant.message, slug, grant.host);
  const { rec } = grant;
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
  if (isComposioHost(upstream.hostname))
    return sendDenied(ctx, claims, 403, "backend_only", "Composio calls must use /v1/composio", slug, rec.host);
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

  const headers = brokerRequestHeaders(rec, callerHeaders(ctx));

  let upstreamResp: GitHttpFetchResponse;
  try {
    upstreamResp = await (ctx.deps.gitHttpFetch ?? realGitHttpFetch)(upstream.toString(), {
      method,
      headers,
      ...(method === "POST" ? { body: ctx.req } : {}),
    });
  } catch {
    ctx.deps.credentialUsage?.record(tenantOf(ctx), {
      slug,
      host: rec.host,
      status: "error",
      scopeLabel: claims.scopeId,
      principalId: claims.actorId,
    });
    ctx.deps.auditLog?.record(tenantOf(ctx), {
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

  ctx.deps.credentialUsage?.record(tenantOf(ctx), {
    slug,
    host: rec.host,
    status: "ok",
    upstreamStatus: upstreamResp.status,
    scopeLabel: claims.scopeId,
    principalId: claims.actorId,
  });
  ctx.deps.auditLog?.record(tenantOf(ctx), {
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
  relayStream(upstreamResp.body, ctx.res);
}
