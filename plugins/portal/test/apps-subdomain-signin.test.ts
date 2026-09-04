import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://localhost:18198";
process.env.PORTAL_SESSION_SECRET = "apps-subdomain-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "apps-subdomain-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_COOKIE_DOMAIN = "qm.example.com";
process.env.PORTAL_APPS_DOMAIN = "apps.qm.example.com";
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "viewer@example.com";

const { server, hostIsWithinDomain } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

const APP_URL = "https://contracts.apps.qm.example.com/?dpl_signin=1";

test("the session cookie is scoped to the parent domain so app subdomains receive it", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=/admin/`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const cookies = login.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith("portal_session=") && !/portal_session=;/.test(c));
  assert.ok(session, "expected a portal_session cookie");
  assert.match(session, /Domain=qm\.example\.com/);
  assert.ok(
    cookies.some((c) => c.startsWith("portal_session=;") && !c.includes("Domain=")),
    "expected the stale host-only portal_session to be cleared",
  );
});

test("sign-in returns the visitor to the app they came from, not the chat home", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent(APP_URL)}`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "https://contracts.apps.qm.example.com/?dpl_signin=1");
});

test("only single-label app hosts under the apps domain survive the returnTo", async () => {
  const rejected = [
    "https://evil.com/",
    "http://contracts.apps.qm.example.com/",
    "https://a.b.apps.qm.example.com/",
    "https://notapps.qm.example.com/",
    "https://contracts.apps.qm.example.com.evil.com/",
    "https://user:pw@contracts.apps.qm.example.com/",
  ];
  for (const returnTo of rejected) {
    const res = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
    assert.equal(res.headers.get("location"), "/", `expected "/" for ${returnTo}`);
  }
});

test("the cookie-domain boot check matches the browser's suffix rule", () => {
  assert.equal(hostIsWithinDomain("qm.example.com", "qm.example.com"), true);
  assert.equal(hostIsWithinDomain("apps.qm.example.com", "qm.example.com"), true);
  assert.equal(hostIsWithinDomain("contracts.apps.qm.example.com", "qm.example.com"), true);
  assert.equal(hostIsWithinDomain("QM.EXAMPLE.COM", ".qm.example.com"), true);
  assert.equal(hostIsWithinDomain("notqm.example.com", "qm.example.com"), false);
  assert.equal(hostIsWithinDomain("qm.example.com.evil.com", "qm.example.com"), false);
  assert.equal(hostIsWithinDomain("example.com", "qm.example.com"), false);
  assert.equal(hostIsWithinDomain("", "qm.example.com"), false);
  assert.equal(hostIsWithinDomain("qm.example.com", ""), false);
});

test("logout clears the cookie at both scopes", async () => {
  const out = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: "http://localhost:18198" },
    redirect: "manual",
  });
  const cookies = out.headers.getSetCookie().filter((c) => c.startsWith("portal_session="));
  assert.ok(
    cookies.some((c) => /Domain=qm\.example\.com/.test(c)),
    "expected the domain-scoped cookie to be cleared",
  );
  assert.ok(
    cookies.some((c) => !/Domain=/.test(c)),
    "expected the host-only cookie to be cleared",
  );
});
