import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

process.env.PORTAL_PUBLIC_URL = "https://agent.example.test";
process.env.PORTAL_SESSION_SECRET = "client-ip-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "client-ip-test-core-secret";
process.env.PORTAL_XFF_TRUSTED_HOPS = "2";

const { clientIpOf } = await import("../src/index.ts");

const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;

test("with two trusted proxies the client is the hop the inner proxy recorded, not the one a client can prepend", () => {
  assert.equal(clientIpOf(req({ "x-forwarded-for": "203.0.113.7, 198.51.100.1" })), "203.0.113.7");
  assert.equal(
    clientIpOf(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 198.51.100.1" })),
    "203.0.113.7",
    "a spoofed leading hop is ignored — only the rightmost trusted hops count",
  );
  assert.equal(
    clientIpOf(req({ "x-forwarded-for": "203.0.113.7" })),
    "10.0.0.1",
    "a short chain falls back to the socket",
  );
  assert.equal(clientIpOf(req({})), "10.0.0.1");
});
