import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { startWithFakeCore, type CoreHit } from "./fake-core.ts";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PUBLIC_WEB_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "local-auth-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "local-auth-test-core-secret";
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-admin";

const { isLoopbackAddress } = await import("../src/index.ts");
const { base, hits, close } = await startWithFakeCore();

test.after(() => {
  close();
  upstream.close();
});

test("local auth bypass signs in loopback portal requests without OIDC", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=/settings/`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/settings/");
  assert.match(login.headers.get("set-cookie") ?? "", /portal_session=[^,]*Max-Age=604800\b/);
  const session = login.headers.getSetCookie().find((cookie) => cookie.startsWith("portal_session="));
  const twin = login.headers.getSetCookie().find((cookie) => cookie.startsWith("portal_session_x="));
  assert.ok(session && twin);
  assert.equal(twin.split(";")[0], session.split(";")[0]!.replace("portal_session=", "portal_session_x="));
  assert.match(twin, /SameSite=Lax/);
  assert.doesNotMatch(twin, /Secure/);

  const settings = await fetch(`${base}/settings/users`);
  assert.equal(settings.status, 200);
  assert.match(settings.headers.get("set-cookie") ?? "", /portal_session=[^;]+;/);
  const hit = (await settings.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.url, "/settings/users");
  const { deriveKey, openSession, readCookie } = await import("../src/session.ts");
  const key = deriveKey("local-auth-test-portal-secret", "portal.session.v1");
  const carried = openSession(readCookie(hit.cookie ?? "", "portal_session"), key, Date.now(), "acme", 604800);
  assert.equal(carried?.sub, "local-admin");
  const stale = await fetch(`${base}/settings/users`, { headers: { cookie: "portal_session=from-another-instance" } });
  const staleHit = (await stale.json()) as CoreHit;
  assert.equal(staleHit.cookie?.match(/portal_session=/g)?.length, 1);
  const replaced = openSession(readCookie(staleHit.cookie ?? "", "portal_session"), key, Date.now(), "acme", 604800);
  assert.equal(replaced?.sub, "local-admin");
});

test("local auth bypass only treats loopback client addresses as local", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.4.5.6"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("local auth bypass respects logout until explicit login", async () => {
  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: process.env.PUBLIC_WEB_URL ?? "" },
    redirect: "manual",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /portal_local_logout=1/);
  const destination = ((await logout.json()) as { redirectTo: string }).redirectTo;
  assert.equal(destination, "/auth/signed-out");
  const landing = await fetch(`${base}${destination}`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /You have signed out of this portal/);

  const before = hits.length;
  const loggedOut = await fetch(`${base}/settings/users`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(loggedOut.status, 401);
  assert.equal(hits.length, before);

  const login = await fetch(`${base}/auth/login?returnTo=/settings/`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie") ?? "", /portal_local_logout=;[^,]*Max-Age=0/);
});
