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

process.env.PORTAL_PUBLIC_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "local-auth-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "local-auth-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_LOCAL_AUTH_BYPASS_LAN = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-admin";

const { isLoopbackAddress, isPrivateNetworkAddress, privateLanSameOriginRequest, server } =
  await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
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
  const body = (await settings.json()) as { url: string; cookie: string };
  assert.equal(body.url, "/settings/users");
  assert.equal(body.cookie, "webuiuser=local-admin");
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

test("LAN auth bypass only recognizes private network client addresses", () => {
  for (const address of [
    "10.16.80.90",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.10",
    "169.254.1.2",
    "::ffff:10.16.80.90",
    "fd12:3456::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "2001:4860:4860::8888", undefined]) {
    assert.equal(isPrivateNetworkAddress(address), false, String(address));
  }
});

test("LAN auth bypass accepts only same-origin forms served from the private portal address", () => {
  const request = (remoteAddress: string, host: string, origin: string) =>
    ({
      headers: { host, origin, "sec-fetch-site": "same-origin" },
      socket: { remoteAddress },
    }) as unknown as IncomingMessage;
  assert.equal(
    privateLanSameOriginRequest(request("10.16.80.42", "10.16.80.90:8113", "http://10.16.80.90:8113")),
    true,
  );
  assert.equal(privateLanSameOriginRequest(request("10.16.80.42", "10.16.80.90:8113", "https://attacker.test")), false);
  assert.equal(privateLanSameOriginRequest(request("8.8.8.8", "10.16.80.90:8113", "http://10.16.80.90:8113")), false);
  assert.equal(
    privateLanSameOriginRequest(request("10.16.80.42", "example.test:8113", "http://example.test:8113")),
    false,
  );
});

test("local auth bypass respects logout until explicit login", async () => {
  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: process.env.PORTAL_PUBLIC_URL ?? "" },
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

  const loggedOut = await fetch(`${base}/settings/users`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(loggedOut.status, 401);

  const login = await fetch(`${base}/auth/login?returnTo=/settings/`, {
    headers: { cookie: "portal_local_logout=1" },
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie") ?? "", /portal_local_logout=;[^,]*Max-Age=0/);
});
