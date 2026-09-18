import { publicBrokerFetch } from "./public-broker-fetch.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { ScopeId } from "../types.ts";
import type { CredentialUsageSink } from "../admin/credential-usage-sink.ts";
import {
  credentialInjectionError,
  type DecryptedServiceCredential,
  type ServiceCredentialReader,
} from "../credentials/keychain.ts";

interface BrokerFetchResponse {
  status: number;
  contentType?: string;
  text(): Promise<string>;
}

export type BrokerFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<BrokerFetchResponse>;

export const realBrokerFetch: BrokerFetch = async (url, init) => {
  const r = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: "manual",
  });
  return {
    status: r.status,
    ...(r.headers.get("content-type") ? { contentType: r.headers.get("content-type")! } : {}),
    text: () => r.text(),
  };
};

export interface BrokerRequest {
  credential?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: unknown;
}

export interface BrokerResult {
  status: number;
  json: unknown;
}

const ALLOWED_CALLER_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

const MAX_RESPONSE_BYTES = 5_000_000;

function brokerHostMatches(requestHost: string, pinnedHost: string): boolean {
  const h = requestHost.toLowerCase();
  const p = pinnedHost.toLowerCase();
  return h === p || h.endsWith(`.${p}`);
}

function resolvesToParentSegment(pathname: string): boolean {
  let current = pathname;
  for (let depth = 0; depth < 4; depth++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded.split(/[/\\]/).some((seg) => seg === ".." || seg === ".")) return true;
    if (decoded === current) return false;
    current = decoded;
  }
  return true;
}

export function brokerPathAllowed(pathname: string, prefixes?: string[]): boolean {
  if (resolvesToParentSegment(pathname)) return false;
  const allow = prefixes && prefixes.length ? prefixes : ["/"];
  return allow.some((pre) =>
    pre.endsWith("/") ? pathname.startsWith(pre) : pathname === pre || pathname.startsWith(`${pre}/`),
  );
}

export function brokerCredentialAuthHeader(rec: DecryptedServiceCredential): [string, string] {
  const injHeader = rec.injection?.header || "Authorization";
  const rawScheme = rec.injection?.scheme ?? "Bearer ";
  const injScheme = rawScheme && !/\s$/.test(rawScheme) ? `${rawScheme} ` : rawScheme;
  return [injHeader, `${injScheme}${rec.secret}`];
}

export async function brokerCredentialCall(opts: {
  claims: CapabilityClaims;
  body: BrokerRequest;
  orgScopeId: ScopeId;
  reader: ServiceCredentialReader;
  deploymentReader?: (credential: string) => Promise<DecryptedServiceCredential | null>;
  fetchImpl: BrokerFetch;
  personalFetchImpl?: BrokerFetch;
  usage?: CredentialUsageSink;
  audit?: (e: {
    principalId: string;
    action: string;
    resource: string;
    scopeLabel: string;
    status?: string;
    detail?: string;
  }) => void;
}): Promise<BrokerResult> {
  const { claims, body, orgScopeId, reader, fetchImpl } = opts;
  const slug = typeof body.credential === "string" ? body.credential : "";
  const method = (typeof body.method === "string" ? body.method : "GET").toUpperCase();
  const rawUrl = typeof body.url === "string" ? body.url : "";

  const deny = (httpStatus: number, code: string, message: string, host: string): BrokerResult => {
    opts.usage?.record({ slug, host, status: "denied", scopeLabel: claims.scopeId, principalId: claims.actorId });
    opts.audit?.({
      principalId: claims.actorId,
      action: "credential.broker.denied",
      resource: slug || "(none)",
      scopeLabel: claims.scopeId,
      status: "denied",
      detail: claims.deployment ? `${code} deployment:${claims.deployment}` : code,
    });
    return { status: httpStatus, json: { error: code, message } };
  };

  if (!slug || !rawUrl) {
    return deny(400, "bad_request", "credential (ID or org slug) and url are required", "");
  }
  if (
    !(claims.deployment && opts.deploymentReader) &&
    (!Array.isArray(claims.credentials) || !claims.credentials.includes(slug))
  ) {
    return deny(403, "not_entitled", "this session is not entitled to that credential", "");
  }
  const rec =
    claims.deployment && opts.deploymentReader
      ? await opts.deploymentReader(slug)
      : await reader.getServiceCredentialSecret(orgScopeId, slug);
  if (!rec || !rec.enabled || rec.delivery === "env") {
    return deny(404, "credential_unavailable", "credential not found or disabled", rec?.host ?? "");
  }
  if (claims.deployment && !rec.deployments) {
    return deny(403, "not_available_to_deployments", "this credential is switched off for published apps", rec.host);
  }
  if (credentialInjectionError(rec.injection)) {
    return deny(503, "invalid_injection", "credential injection configuration is invalid", rec.host);
  }
  if (
    body.headers &&
    typeof body.headers === "object" &&
    Object.keys(body.headers).some((key) => key.toLowerCase() === "x-qm-actor")
  ) {
    return deny(400, "reserved_header", "x-qm-actor is set only by the broker", rec.host);
  }
  if (rec.injection?.actor && (typeof claims.actorId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(claims.actorId))) {
    return deny(403, "invalid_actor", "actor identity cannot be attested", rec.host);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return deny(400, "bad_url", "url is not a valid absolute URL", rec.host);
  }
  if (parsed.protocol !== "https:") return deny(403, "scheme_not_allowed", "only https targets are allowed", rec.host);
  if (
    rec.injection?.actor || rec.authHeaders
      ? parsed.hostname.toLowerCase() !== rec.host.toLowerCase()
      : !brokerHostMatches(parsed.hostname, rec.host)
  ) {
    return deny(403, "host_not_allowed", "url host is not the credential's pinned host", rec.host);
  }
  if ((rec.injection?.actor || rec.authHeaders) && parsed.port) {
    return deny(403, "port_not_allowed", "actor-attested credentials require standard HTTPS", rec.host);
  }
  if (rec.authHeaders) {
    const target = /^https:\/\/([^/?#]+)([^?#]*)/.exec(rawUrl);
    if (
      !target ||
      target[1]!.toLowerCase() !== rec.host ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      /[\\\x00-\x20\x7f]/.test(rawUrl) ||
      /%(?:25|2f|5c)/i.test(target[2]!) ||
      !brokerPathAllowed(target[2] || "/", rec.allowedPathPrefixes)
    ) {
      return deny(
        403,
        "target_not_allowed",
        "binding requires an exact HTTPS host and an unambiguous allowed path",
        rec.host,
      );
    }
  }
  const methods = (rec.allowedMethods && rec.allowedMethods.length ? rec.allowedMethods : ["GET"]).map((m) =>
    m.toUpperCase(),
  );
  if (!methods.includes(method))
    return deny(403, "method_not_allowed", `method ${method} is not allowed for this credential`, rec.host);
  if (!brokerPathAllowed(parsed.pathname, rec.allowedPathPrefixes)) {
    return deny(403, "path_not_allowed", "url path is not in the credential's allowlist", rec.host);
  }

  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object") {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof v === "string" && ALLOWED_CALLER_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
  }
  if (rec.authHeaders) Object.assign(headers, rec.authHeaders);
  else {
    const [injHeader, injValue] = brokerCredentialAuthHeader(rec);
    headers[injHeader] = injValue;
  }
  if (rec.injection?.actor) headers["x-qm-actor"] = claims.actorId;

  let resp: BrokerFetchResponse;
  try {
    const send = rec.authHeaders ? (opts.personalFetchImpl ?? publicBrokerFetch) : fetchImpl;
    resp = await send(parsed.toString(), {
      method,
      headers,
      ...(typeof body.body === "string" ? { body: body.body } : {}),
    });
  } catch {
    opts.usage?.record({
      slug,
      host: rec.host,
      status: "error",
      scopeLabel: claims.scopeId,
      principalId: claims.actorId,
    });
    opts.audit?.({
      principalId: claims.actorId,
      action: "credential.broker.error",
      resource: slug,
      scopeLabel: claims.scopeId,
      status: "error",
      ...(claims.deployment ? { detail: `deployment:${claims.deployment}` } : {}),
    });
    return {
      status: 502,
      json: { error: "upstream_unreachable", message: "the credential's host could not be reached" },
    };
  }

  let text = await resp.text();
  let truncated = false;
  if (text.length > MAX_RESPONSE_BYTES) {
    text = text.slice(0, MAX_RESPONSE_BYTES);
    truncated = true;
  }
  opts.usage?.record({
    slug,
    host: rec.host,
    status: "ok",
    upstreamStatus: resp.status,
    scopeLabel: claims.scopeId,
    principalId: claims.actorId,
  });
  opts.audit?.({
    principalId: claims.actorId,
    action: "credential.broker.use",
    resource: slug,
    scopeLabel: claims.scopeId,
    status: "ok",
    ...(claims.deployment ? { detail: `deployment:${claims.deployment}` } : {}),
  });
  return {
    status: 200,
    json: {
      status: resp.status,
      ...(resp.contentType ? { contentType: resp.contentType } : {}),
      body: text,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}
