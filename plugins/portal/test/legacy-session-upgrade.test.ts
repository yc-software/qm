import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const lookups: string[] = [];
const upstream = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    const m = req.url?.match(/^\/v1\/identities\/([a-z]+)\/([^/?]+)\/principal/);
    if (m) {
      lookups.push(`${m[1]}:${decodeURIComponent(m[2]!)}`);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ principalId: "11111111-1111-4111-8111-111111111111" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url }));
  });
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const SECRET = "legacy-session-test-portal-secret-0123456789";
process.env.PORTAL_PUBLIC_URL = "https://qm.test";
process.env.PORTAL_SESSION_SECRET = SECRET;
process.env.CORE_SIGNING_SECRET = "legacy-session-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
const { deriveKey, seal, openSession } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const sessionKey = deriveKey(SECRET, "portal.session.v1");

test.after(() => {
  server.close();
  upstream.close();
});

test("a pre-principal session cookie without prov/pid is upgraded in place instead of forcing sign-in", async () => {
  const iat = Math.floor(Date.now() / 1000);
  const legacy = seal({ k: "session", sub: "Alice@Example.com", org: "acme", iat, exp: iat + 3600 }, sessionKey);
  const r = await fetch(`${base}/api/whoami`, {
    headers: { cookie: `portal_session=${encodeURIComponent(legacy)}`, accept: "application/json" },
    redirect: "manual",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(lookups, ["email:alice@example.com"]);
  const resealed = r.headers
    .getSetCookie()
    .map((c) => c.match(/^portal_session=([^;]+)/)?.[1])
    .find(Boolean);
  assert.ok(resealed, "session cookie re-sealed");
  const claims = openSession(decodeURIComponent(resealed), sessionKey, Date.now(), "acme", 86400);
  assert.equal(claims?.prov, "email");
  assert.equal(claims?.pid, "11111111-1111-4111-8111-111111111111");
  assert.equal(claims?.sub, "alice@example.com");
});
