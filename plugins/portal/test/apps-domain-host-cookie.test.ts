import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const upstream = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PUBLIC_WEB_URL = "http://qm.localhost:18199";
process.env.PORTAL_SESSION_SECRET = "apps-domain-host-cookie-portal-secret";
process.env.CORE_SIGNING_SECRET = "apps-domain-host-cookie-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
delete process.env.PORTAL_APPS_DOMAIN;
delete process.env.PORTAL_COOKIE_DOMAIN;
process.env.DEPLOY_APPS_DOMAIN = "apps.qm.localhost";
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "viewer@example.com";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

function sessionCookies(res: Response): string[] {
  return res.headers.getSetCookie().filter((c) => c.startsWith("portal_session"));
}

test("an apps domain under the portal host keeps the session cookie on the portal host", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=/settings/`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const cookies = sessionCookies(login);
  const issued = cookies.filter((c) => !/^portal_session(_x)?=;/.test(c));
  assert.equal(issued.length, 2);
  for (const cookie of issued) assert.doesNotMatch(cookie, /Domain=/);
  const firstIssued = cookies.indexOf(issued[0]!);
  const staleClears = cookies.filter((c) => /^portal_session(_x)?=;/.test(c) && /Domain=qm\.localhost/.test(c));
  assert.equal(staleClears.length, 2);
  for (const clear of staleClears) assert.ok(cookies.indexOf(clear) < firstIssued);
});

test("logout clears the host cookie and any parent-domain cookie an earlier sign-in left", async () => {
  const out = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: "http://qm.localhost:18199" },
    redirect: "manual",
  });
  const cookies = sessionCookies(out).filter((c) => c.startsWith("portal_session="));
  assert.ok(cookies.some((c) => !/Domain=/.test(c)));
  assert.ok(cookies.some((c) => /Domain=qm\.localhost/.test(c)));
});
