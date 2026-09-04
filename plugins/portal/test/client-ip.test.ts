import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.equal(
    clientIpOf(req({ "fly-client-ip": "192.0.2.5", "x-forwarded-for": "1.1.1.1, 203.0.113.7, 198.51.100.1" })),
    "203.0.113.7",
    "off Fly the edge header is ignored even when a client sets it",
  );
});

test("on Fly the edge header is the identity and a client-supplied X-Forwarded-For is ignored", async () => {
  const onFly = { ...process.env, FLY_APP_NAME: "acme-portal", PORTAL_XFF_TRUSTED_HOPS: "2" };
  const script = `
    process.env.PORTAL_PUBLIC_URL = "https://agent.example.test";
    process.env.PORTAL_SESSION_SECRET = "client-ip-test-portal-secret";
    process.env.CORE_SIGNING_SECRET = "client-ip-test-core-secret";
    const { clientIpOf } = await import("./src/index.ts");
    const req = (headers) => ({ headers, socket: { remoteAddress: "10.0.0.1" } });
    console.log([
      clientIpOf(req({ "fly-client-ip": "192.0.2.5", "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
      clientIpOf(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
    ].join(","));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: onFly,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /^192\.0\.2\.5,10\.0\.0\.1$/m,
    "the Fly header wins, and without it the socket does — never XFF",
  );
});
