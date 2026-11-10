import { validateHeaderName, validateHeaderValue } from "node:http";
import { HOP_BY_HOP } from "../util/http-proxy.ts";
import type { AttestAudience } from "../directory/person.ts";

export interface CredentialInjection {
  header?: string;
  scheme?: string;
  actor?: boolean;
  audience?: AttestAudience;
  headers?: Record<string, string>;
}

const DEFAULT_AUTH_HEADER = "Authorization";
const RESERVED_FIXED_HEADERS = new Set([
  ...HOP_BY_HOP,
  "authorization",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "x-qm-actor",
]);

const headerError = (validate: () => void): boolean => {
  try {
    validate();
    return false;
  } catch {
    return true;
  }
};

function fixedHeadersError(headers: unknown, authHeader: string): string | undefined {
  if (headers === undefined) return undefined;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "injection.headers must be an object";
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (headerError(() => validateHeaderName(name)))
      return `injection.headers: "${name}" is not a valid HTTP header name`;
    if (RESERVED_FIXED_HEADERS.has(lower) || lower === authHeader) return `injection.headers cannot set ${lower}`;
    if (seen.has(lower)) return `injection.headers lists ${lower} more than once`;
    seen.add(lower);
    if (typeof value !== "string" || !value || headerError(() => validateHeaderValue(name, value)))
      return `injection.headers.${name} must be a non-empty valid HTTP header value`;
  }
  return undefined;
}

export function credentialRequestHeaders(rec: {
  injection?: CredentialInjection;
  secret: string;
}): Record<string, string> {
  const header = rec.injection?.header || DEFAULT_AUTH_HEADER;
  const rawScheme = rec.injection?.scheme ?? "Bearer ";
  const scheme = rawScheme && !/\s$/.test(rawScheme) ? `${rawScheme} ` : rawScheme;
  return { ...rec.injection?.headers, [header]: `${scheme}${rec.secret}` };
}

export function credentialInjectionError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "injection must be an object";
  const injection = value as CredentialInjection;
  if (injection.actor !== undefined && typeof injection.actor !== "boolean") return "injection.actor must be boolean";
  if (injection.audience !== undefined && injection.audience !== "personal" && injection.audience !== "any")
    return "injection.audience must be personal or any";
  if (injection.audience === "any" && injection.actor !== true)
    return "injection.audience any requires injection.actor";
  if (
    injection.header !== undefined &&
    (typeof injection.header !== "string" || headerError(() => validateHeaderName(injection.header!)))
  )
    return "authentication header must be a valid HTTP header name";
  if (injection.header?.toLowerCase() === "x-qm-actor") return "x-qm-actor is reserved for broker actor attestation";
  if (injection.scheme !== undefined && (typeof injection.scheme !== "string" || /[\r\n]/.test(injection.scheme)))
    return "authentication value prefix must be a single line";
  return fixedHeadersError(injection.headers, (injection.header || DEFAULT_AUTH_HEADER).toLowerCase());
}
