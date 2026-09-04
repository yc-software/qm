import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { ScopeId } from "../types.ts";
import type { CredentialUsageSink } from "../admin/credential-usage-sink.ts";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../credentials/keychain.ts";

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

/**
 * A pathname that could resolve to a parent directory upstream must never pass
 * the prefix check. The prefix match runs on the RAW pathname, but upstream
 * servers decode percent-escapes and normalize dot segments — so `..` hidden
 * behind any layer of percent-encoding (`..%2f`, `%2e%2e/`, `%252e%252e`) can
 * escape the allowed prefix after we've approved it. Decode to a fixed point
 * (bounded) and refuse any form that ever contains a dot segment; refuse
 * undecodable paths outright.
 */
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
  fetchImpl: BrokerFetch;
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
      detail: code,
    });
    return { status: httpStatus, json: { error: code, message } };
  };

  if (!slug || !rawUrl) {
    return { status: 400, json: { error: "bad_request", message: "credential (slug) and url are required" } };
  }
  if (!Array.isArray(claims.credentials) || !claims.credentials.includes(slug)) {
    return deny(403, "not_entitled", "this session is not entitled to that credential", "");
  }
  const rec: DecryptedServiceCredential | null = await reader.getServiceCredentialSecret(orgScopeId, slug);
  if (!rec || !rec.enabled || rec.delivery === "env") {
    return deny(404, "credential_unavailable", "credential not found or disabled", rec?.host ?? "");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return deny(400, "bad_url", "url is not a valid absolute URL", rec.host);
  }
  if (parsed.protocol !== "https:") return deny(403, "scheme_not_allowed", "only https targets are allowed", rec.host);
  if (!brokerHostMatches(parsed.hostname, rec.host)) {
    return deny(403, "host_not_allowed", "url host is not the credential's pinned host", rec.host);
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
  const [injHeader, injValue] = brokerCredentialAuthHeader(rec);
  headers[injHeader] = injValue;

  let resp: BrokerFetchResponse;
  try {
    resp = await fetchImpl(parsed.toString(), {
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
