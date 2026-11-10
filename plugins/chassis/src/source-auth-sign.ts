import { createHmac } from "node:crypto";

export function canonicalPayload(method: string, pathWithQuery: string, body: string): string {
  return `${method}\n${pathWithQuery}\n${body}`;
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
  if (!secret) return { ...base };
  const canonical = canonicalPayload(method, pathWithQuery, body);
  return { ...base, "x-timestamp": String(nowSec), "x-signature": signRequest(secret, nowSec, canonical) };
}
