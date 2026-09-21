import { createHmac } from "node:crypto";

export const TENANT_HEADER = "x-qm-tenant";

export function bindTenantPayload(payload: string, tenantId?: string): string {
  if (tenantId === undefined) return payload;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(tenantId)) throw new Error("Invalid tenant ID");
  return `qm-tenant:${tenantId}\n${payload}`;
}

export function canonicalPayload(method: string, pathWithQuery: string, body: string, tenantId?: string): string {
  return bindTenantPayload(`${method}\n${pathWithQuery}\n${body}`, tenantId);
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
  tenantId: string | undefined = base[TENANT_HEADER] ?? process.env.CORE_TENANT_ID,
): Record<string, string> {
  const canonical = canonicalPayload(method, pathWithQuery, body, tenantId);
  const headers = { ...base, ...(tenantId === undefined ? {} : { [TENANT_HEADER]: tenantId }) };
  if (!secret) return headers;
  return { ...headers, "x-timestamp": String(nowSec), "x-signature": signRequest(secret, nowSec, canonical) };
}
