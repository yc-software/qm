import { createHmac } from "node:crypto";
import { boundTenant } from "./tenant.ts";

export const TENANT_HEADER = "x-qm-tenant";

export function canonicalPayload(method: string, pathWithQuery: string, body: string, tenant = ""): string {
  return `${method}\n${pathWithQuery}\n${tenant}\n${body}`;
}

export function signRequest(secret: string, timestampSec: number, canonical: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:${canonical}`).digest("hex")}`;
}

export function signedRequestHeaders(
  secret: string | undefined,
  method: string,
  pathWithQuery: string,
  body = "",
  base: Record<string, string> = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const tenant = base[TENANT_HEADER] ?? boundTenant();
  const headers = tenant ? { ...base, [TENANT_HEADER]: tenant } : { ...base };
  if (!secret) return headers;
  const canonical = canonicalPayload(method, pathWithQuery, body, tenant);
  return { ...headers, "x-timestamp": String(nowSec), "x-signature": signRequest(secret, nowSec, canonical) };
}
