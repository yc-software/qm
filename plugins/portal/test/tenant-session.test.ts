import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";

const secret = "tenant-session-test-secret";
const sessionKey = deriveKey(secret, "portal.session.v1");
const a = randomUUID();
const b = randomUUID();
const solo = randomUUID();
const hosts: Record<string, { tenant: string; multi: boolean; sole: boolean }> = {
  "a.example.test": { tenant: a, multi: true, sole: false },
  "b.example.test": { tenant: b, multi: true, sole: false },
  "solo.example.test": { tenant: solo, multi: false, sole: true },
};
const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://core.test").pathname;
  res.setHeader("content-type", "application/json");
  const host = path.startsWith("/v1/operator/hosts/") ? decodeURIComponent(path.slice(19)) : undefined;
  if (host !== undefined)
    return void res.end(JSON.stringify(hosts[host] ?? { tenant: null, multi: true, sole: false }));
  res.end(JSON.stringify({ path }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "tenant-session-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
test.after(() => {
  server.close();
  upstream.close();
});

function cookie(tenant?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub: "viewer@example.test", org: "acme", auth: now, iat: now, exp: now + 600 };
  return `portal_session=${seal(tenant ? { ...claims, t: tenant } : claims, sessionKey)}`;
}

function get(
  host: string,
  session: string,
  accept = "application/json",
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/settings", headers: { host, cookie: session, accept } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("a session minted for one tenant is signed out on another tenant's host", async () => {
  assert.equal((await get("b.example.test", cookie(a))).status, 401);
  const html = await get("b.example.test", cookie(a), "text/html");
  assert.equal(html.status, 302);
  assert.match(html.location ?? "", /^\/auth\/login/);
  assert.notEqual((await get("a.example.test", cookie(a))).status, 401);
});

test("a session without a tenant works only while one tenant exists", async () => {
  assert.notEqual((await get("solo.example.test", cookie())).status, 401);
  assert.equal((await get("a.example.test", cookie())).status, 401);
  assert.equal((await get("solo.example.test", cookie(a))).status, 401);
});
