import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { deriveKey, seal, open } from "../src/session.ts";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "https://qm.example.com";
process.env.PORTAL_SESSION_SECRET = "apps-domain-defaults-portal-secret";
process.env.CORE_SIGNING_SECRET = "apps-domain-defaults-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
delete process.env.PORTAL_APPS_DOMAIN;
delete process.env.PORTAL_COOKIE_DOMAIN;
process.env.DEPLOY_APPS_DOMAIN = "apps.qm.example.com";

const { derivedCookieDomain, bootChecks, server } = await import("../src/index.ts");

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.closeAllConnections();
  server.close();
  upstream.closeAllConnections();
  upstream.close();
});

test("the cookie domain derives only when the apps domain sits under the portal host", () => {
  assert.equal(derivedCookieDomain("qm.example.com", "apps.qm.example.com"), "qm.example.com");
  assert.equal(derivedCookieDomain("Example.com", "APPS.example.COM"), "example.com");
  assert.equal(
    derivedCookieDomain("portal.example.com", "apps.example.com"),
    undefined,
    "sibling layouts need an explicit PORTAL_COOKIE_DOMAIN — guessing a shared parent risks landing on a public suffix",
  );
  assert.equal(
    derivedCookieDomain("portal.foo.co.uk", "apps.bar.co.uk"),
    undefined,
    "no public-suffix list needed: only the portal host itself, a domain the operator demonstrably controls, is derived",
  );
  assert.equal(
    derivedCookieDomain("localhost", "apps.localhost"),
    undefined,
    "a single-label host is never a cookie domain",
  );
  assert.equal(derivedCookieDomain("", "apps.example.com"), undefined);
  assert.equal(derivedCookieDomain("example.com", "appsXexample.com"), undefined, "dot-boundary required");
});

test("DEPLOY_APPS_DOMAIN can boot without a shared portal-cookie domain", () => {
  assert.doesNotThrow(() => bootChecks());
});

test("an isolated unrelated apps domain boots without a parent-domain portal cookie", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DEPLOY_APPS_DOMAIN: "apps.unrelated.net" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
});

test("default portal session renewal is host-only and clears the old derived domain cookie", async () => {
  const now = Math.floor(Date.now() / 1000);
  const session = seal(
    { k: "session", sub: "alice", org: "acme", iat: now - 4 * 86400, exp: now + 3600 },
    deriveKey("apps-domain-defaults-portal-secret", "portal.session.v1"),
  );
  const response = await fetch(base + "/", {
    redirect: "manual",
    headers: { cookie: `__Host-portal_session=${session}` },
  });
  const cookies = response.headers.getSetCookie();
  const renewed = cookies.find(
    (value) => value.startsWith("__Host-portal_session=") && !value.startsWith("__Host-portal_session=;"),
  );
  assert.ok(renewed, "aged valid session must be renewed");
  assert.match(renewed, /Max-Age=604800\b/);
  assert.match(renewed, /; Secure(?:;|$)/);
  assert.doesNotMatch(renewed, /Domain=/i, "the portal cookie is not shared with app hosts");
  assert.ok(cookies.some((value) => value.startsWith("portal_session=;") && /Domain=qm\.example\.com/i.test(value)));
});

test("a valid legacy parent-name session cannot authenticate after migration", async () => {
  const now = Math.floor(Date.now() / 1000);
  const session = seal(
    { k: "session", sub: "alice", org: "acme", iat: now, exp: now + 3600 },
    deriveKey("apps-domain-defaults-portal-secret", "portal.session.v1"),
  );
  const response = await fetch(base + "/", {
    redirect: "manual",
    headers: { cookie: `portal_session=${session}`, accept: "text/html" },
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /^\/auth\/login/);
});

test("prefixed session renewal preserves the thirty-day absolute authentication limit", async () => {
  const now = Math.floor(Date.now() / 1000);
  const key = deriveKey("apps-domain-defaults-portal-secret", "portal.session.v1");
  const auth = now - 29 * 86400;
  const token = seal(
    { k: "session", sub: "alice", org: "acme", auth, iat: now - 4 * 86400, exp: now + 3 * 86400 },
    key,
  );
  const response = await fetch(base + "/", { headers: { cookie: `__Host-portal_session=${token}` } });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("__Host-portal_session="));
  assert.ok(cookie);
  const claims = open(decodeURIComponent(cookie.split(";")[0]!.slice("__Host-portal_session=".length)), key);
  assert.equal(claims?.auth, auth);
  assert.equal(claims?.exp, auth + 30 * 86400);
  const expired = seal(
    { k: "session", sub: "alice", org: "acme", auth: now - 31 * 86400, iat: now, exp: now + 86400 },
    key,
  );
  const denied = await fetch(base + "/", {
    headers: { cookie: `__Host-portal_session=${expired}` },
    redirect: "manual",
  });
  assert.equal(denied.status, 401);
});
