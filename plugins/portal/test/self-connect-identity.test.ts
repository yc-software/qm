import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";
import { PORTAL_IDENTITY_HEADER, verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";

const identitySecret = "self-connect-portal-identity-secret-32+";
const core = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://core.test");
  res.setHeader("content-type", "application/json");
  if (!/^\/v1\/connectors\/oauth\/[^/]+\/start$/.test(url.pathname)) return void res.end("{}");
  const header = req.headers[PORTAL_IDENTITY_HEADER];
  const actor = typeof header === "string" ? verifyPortalIdentity(header, identitySecret, Date.now()) : null;
  if (!actor || actor.p !== url.searchParams.get("principalId")) {
    res.statusCode = 401;
    return void res.end(JSON.stringify({ error: "unauthorized", message: "portal identity required" }));
  }
  res.end(JSON.stringify({ authorizeUrl: "https://identity.provider.test/authorize?x=1" }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const sessionSecret = "self-connect-session-secret-at-least-32";
Object.assign(process.env, {
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: sessionSecret,
  CORE_SIGNING_SECRET: "self-connect-core-signing-secret-32chars",
  PORTAL_IDENTITY_SECRET: identitySecret,
  CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

test("self-connect carries the signed portal identity that core requires under requireSignedPortalIdentity", async () => {
  const now = Math.floor(Date.now() / 1000);
  const session = seal(
    { k: "session", sub: "eve@acme", org: "acme", iat: now, exp: now + 3600 },
    deriveKey(sessionSecret, "portal.session.v1"),
  );
  const r = await fetch(`${base}/connect/doordash/self-connect`, {
    headers: { cookie: `portal_session=${encodeURIComponent(session)}` },
    redirect: "manual",
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://identity.provider.test/authorize?x=1");
});
