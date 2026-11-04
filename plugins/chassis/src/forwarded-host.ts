import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { hostnameOf } from "./host-tenant.ts";

export const FORWARDED_HOST_HEADER = "x-forwarded-host";
const TIMESTAMP_HEADER = "x-qm-forwarded-host-timestamp";
const SIGNATURE_HEADER = "x-qm-forwarded-host-signature";
const WINDOW_SEC = 300;

function sign(secret: string, timestampSec: number, host: string, method: string, pathWithQuery: string): string {
  return `v0=${createHmac("sha256", secret).update(`forwarded-host:v0:${timestampSec}:${host}\n${method}\n${pathWithQuery}`).digest("hex")}`;
}

// Headers a front door adds when it relays a request whose tenant comes from the host the
// visitor used. The host is signed, so the receiver never trusts a bare x-forwarded-host.
export function signedForwardedHost(
  secret: string | undefined,
  host: string,
  method: string,
  pathWithQuery: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  if (!secret) return {};
  const name = hostnameOf(host);
  return {
    [FORWARDED_HOST_HEADER]: name,
    [TIMESTAMP_HEADER]: String(nowSec),
    [SIGNATURE_HEADER]: sign(secret, nowSec, name, method, pathWithQuery),
  };
}

// The forwarded host, only when the front door's signature over it, the method and the path
// verifies within the replay window. Otherwise undefined.
export function verifiedForwardedHost(
  req: IncomingMessage,
  secret: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | undefined {
  const header = (name: string) => {
    const raw = req.headers[name];
    return typeof raw === "string" ? raw : undefined;
  };
  const host = header(FORWARDED_HOST_HEADER);
  const timestamp = Number(header(TIMESTAMP_HEADER));
  const signature = header(SIGNATURE_HEADER);
  if (!secret || !host || !signature || !Number.isInteger(timestamp)) return undefined;
  if (Math.abs(nowSec - timestamp) > WINDOW_SEC) return undefined;
  const expected = Buffer.from(sign(secret, timestamp, host, req.method ?? "GET", req.url ?? "/"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected) ? host : undefined;
}
