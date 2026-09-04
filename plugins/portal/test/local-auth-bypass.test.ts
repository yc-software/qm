import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url === "/api/whoami") {
    const m = (req.headers.cookie ?? "").match(/admin=([^;]+)/);
    const sub = m ? decodeURIComponent(m[1] ?? "") : "";
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: sub === "local-admin" }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "local-auth-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "local-auth-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-admin";

const { isLoopbackAddress, server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

test("local auth bypass signs in loopback portal requests without OIDC", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=/admin/`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/admin/");
  assert.match(login.headers.get("set-cookie") ?? "", /portal_session=/);

  const admin = await fetch(`${base}/admin/api/me`);
  assert.equal(admin.status, 200);
  const body = (await admin.json()) as { url: string; cookie: string };
  assert.equal(body.url, "/api/me");
  assert.equal(body.cookie, "admin=local-admin");
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
    headers: { origin: process.env.PORTAL_PUBLIC_URL ?? "" },
    redirect: "manual",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /portal_local_logout=1/);

  const loggedOut = await fetch(`${base}/admin/api/me`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(loggedOut.status, 401);

  const login = await fetch(`${base}/auth/login?returnTo=/admin/`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie") ?? "", /portal_local_logout=;[^,]*Max-Age=0/);
});
