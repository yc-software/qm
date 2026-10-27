import { reportFailure } from "../util/errors.ts";
import { readTextPrefix } from "../util/response-body.ts";
import { isObj } from "../util/objects.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { ScopeId } from "../types.ts";
import type { CredentialUsageSink } from "../admin/credential-usage-sink.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  credentialInjectionError,
  credentialRequestHeaders,
  isComposioHost,
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
    text: () => readTextPrefix(r, MAX_RESPONSE_BYTES + 1),
  };
};

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

function brokerRequestHeaders(rec: DecryptedServiceCredential, caller: Record<string, string>): Record<string, string> {
  const injected = credentialRequestHeaders(rec);
  const owned = new Set(Object.keys(injected).map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(caller)) if (!owned.has(name.toLowerCase())) headers[name] = value;
  return { ...headers, ...injected };
}

export function serviceRequestHeaders(
  rec: DecryptedServiceCredential,
  claims: CapabilityClaims,
  caller: Record<string, string>,
): Record<string, string> {
  const headers = brokerRequestHeaders(rec, caller);
  if (rec.injection?.actor) headers["x-qm-actor"] = claims.actorId;
  return headers;
}

export interface BrokerDenial {
  status: number;
  code: string;
  message: string;
}

export async function serviceCallDenial(
  rec: DecryptedServiceCredential,
  claims: CapabilityClaims,
  call: { slug: string; method: string; pathname: string; usage: CredentialUsageSink | undefined },
): Promise<BrokerDenial | undefined> {
  if (credentialInjectionError(rec.injection))
    return { status: 503, code: "invalid_injection", message: "credential injection configuration is invalid" };
  if (rec.injection?.actor && (typeof claims.actorId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(claims.actorId)))
    return { status: 403, code: "invalid_actor", message: "actor identity cannot be attested" };
  if (!brokerMethodAllowed(rec, call.method))
    return {
      status: 403,
      code: "method_not_allowed",
      message: `method ${call.method} is not allowed for this credential`,
    };
  if (!brokerPathAllowed(call.pathname, rec.allowedPathPrefixes))
    return { status: 403, code: "path_not_allowed", message: "url path is not in the credential's allowlist" };
  if (rec.maxRequestsPerDay === undefined) return undefined;
  let admitted: boolean;
  try {
    if (!call.usage) throw new Error("no usage ledger");
    admitted = await call.usage.admitDailyCall(call.slug, rec.maxRequestsPerDay);
  } catch (err) {
    reportFailure("credential-broker: daily cap check", err, call.slug);
    return {
      status: 503,
      code: "daily_cap_unavailable",
      message: "the credential's daily request cap could not be checked",
    };
  }
  return admitted
    ? undefined
    : {
        status: 429,
        code: "daily_cap_reached",
        message: `this credential has used its ${rec.maxRequestsPerDay} requests for today (UTC); it resets at 00:00 UTC`,
      };
}

export function upstreamFailureCode(error: unknown): string {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

export function upstreamUnreachable(code: string): { error: string; message: string } {
  return { error: "upstream_unreachable", message: `the credential's host could not be reached (${code})` };
}

function brokerMethodAllowed(rec: DecryptedServiceCredential, method: string): boolean {
  return (rec.allowedMethods?.length ? rec.allowedMethods : ["GET"]).some((m) => m.toUpperCase() === method);
}

interface BrokerSinks {
  usage?: CredentialUsageSink;
  audit?: Pick<AuditLog, "record">;
}

export function brokerSinks(deps: { credentialUsage?: CredentialUsageSink; auditLog?: AuditLog }): BrokerSinks {
  return {
    ...(deps.credentialUsage ? { usage: deps.credentialUsage } : {}),
    ...(deps.auditLog ? { audit: deps.auditLog } : {}),
  };
}

export function recordBrokerOutcome(
  sinks: BrokerSinks,
  claims: CapabilityClaims,
  kind: "broker" | "http",
  call: { slug: string; host: string; status: "ok" | "error" | "denied"; upstreamStatus?: number; detail?: string },
): void {
  const { slug, host, status, upstreamStatus, detail } = call;
  const who = { scopeLabel: claims.scopeId, principalId: claims.actorId };
  sinks.usage?.record({ slug, host, status, ...(upstreamStatus === undefined ? {} : { upstreamStatus }), ...who });
  sinks.audit?.record({
    at: Date.now(),
    ...who,
    action: `credential.${kind}.${status === "ok" ? "use" : status}`,
    resource: slug || "(none)",
    status,
    ...(detail ? { detail } : {}),
  });
}

type CredentialGrant =
  | { rec: DecryptedServiceCredential }
  | { rec?: undefined; status: number; code: string; message: string; host: string };

export async function grantedCredential(
  claims: CapabilityClaims,
  slug: string,
  reader: ServiceCredentialReader,
  orgScopeId: ScopeId,
): Promise<CredentialGrant> {
  if (!Array.isArray(claims.credentials) || !claims.credentials.includes(slug))
    return { status: 403, code: "not_entitled", message: "this session is not entitled to that credential", host: "" };
  const rec = await reader.getServiceCredentialSecret(orgScopeId, slug);
  if (!rec || !rec.enabled || rec.delivery === "env")
    return {
      status: 404,
      code: "credential_unavailable",
      message: "credential not found or disabled",
      host: rec?.host ?? "",
    };
  if (claims.deployment && !rec.deployments)
    return {
      status: 403,
      code: "not_available_to_deployments",
      message: "this credential is switched off for published apps",
      host: rec.host,
    };
  return { rec };
}

export async function brokerCredentialCall(
  opts: BrokerSinks & {
    claims: CapabilityClaims;
    body: Record<string, unknown>;
    orgScopeId: ScopeId;
    reader: ServiceCredentialReader;
    fetchImpl: BrokerFetch;
  },
): Promise<BrokerResult> {
  const { claims, body, orgScopeId, reader, fetchImpl } = opts;
  const slug = typeof body.credential === "string" ? body.credential : "";
  const method = (typeof body.method === "string" ? body.method : "GET").toUpperCase();
  const rawUrl = typeof body.url === "string" ? body.url : "";

  const deny = (httpStatus: number, code: string, message: string, host: string): BrokerResult => {
    recordBrokerOutcome(opts, claims, "broker", { slug, host, status: "denied", detail: code });
    return { status: httpStatus, json: { error: code, message } };
  };

  if (!slug || !rawUrl) {
    return { status: 400, json: { error: "bad_request", message: "credential (slug) and url are required" } };
  }
  const grant = await grantedCredential(claims, slug, reader, orgScopeId);
  if (!grant.rec) return deny(grant.status, grant.code, grant.message, grant.host);
  const { rec } = grant;
  const callerHeaders = Object.entries(isObj(body.headers) ? body.headers : {});
  if (callerHeaders.some(([key]) => key.toLowerCase() === "x-qm-actor")) {
    return deny(400, "reserved_header", "x-qm-actor is set only by the broker", rec.host);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return deny(400, "bad_url", "url is not a valid absolute URL", rec.host);
  }
  if (isComposioHost(parsed.hostname))
    return deny(403, "backend_only", "Composio calls must use the identity-bound /v1/composio API", rec.host);
  if (parsed.protocol !== "https:") return deny(403, "scheme_not_allowed", "only https targets are allowed", rec.host);
  if (
    rec.injection?.actor
      ? parsed.hostname.toLowerCase() !== rec.host.toLowerCase()
      : !brokerHostMatches(parsed.hostname, rec.host)
  ) {
    return deny(403, "host_not_allowed", "url host is not the credential's pinned host", rec.host);
  }
  if (rec.injection?.actor && parsed.port) {
    return deny(403, "port_not_allowed", "actor-attested credentials require standard HTTPS", rec.host);
  }
  const denial = await serviceCallDenial(rec, claims, { slug, method, pathname: parsed.pathname, usage: opts.usage });
  if (denial) return deny(denial.status, denial.code, denial.message, rec.host);

  const caller: Record<string, string> = {};
  for (const [k, v] of callerHeaders)
    if (typeof v === "string" && ALLOWED_CALLER_HEADERS.has(k.toLowerCase())) caller[k] = v;
  const headers = serviceRequestHeaders(rec, claims, caller);

  let resp: BrokerFetchResponse;
  try {
    resp = await fetchImpl(parsed.toString(), {
      method,
      headers,
      ...(typeof body.body === "string" ? { body: body.body } : {}),
    });
  } catch (error) {
    const detail = upstreamFailureCode(error);
    recordBrokerOutcome(opts, claims, "broker", { slug, host: rec.host, status: "error", detail });
    return { status: 502, json: upstreamUnreachable(detail) };
  }

  let text = await resp.text();
  let truncated = false;
  if (text.length > MAX_RESPONSE_BYTES) {
    text = text.slice(0, MAX_RESPONSE_BYTES);
    truncated = true;
  }
  recordBrokerOutcome(opts, claims, "broker", {
    slug,
    host: rec.host,
    status: "ok",
    upstreamStatus: resp.status,
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
