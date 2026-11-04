import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";

const secret = "tenant-origin-test-secret";
const sessionKey = deriveKey(secret, "portal.session.v1");
const a = randomUUID();
const b = randomUUID();
const hosts: Record<string, { tenant: string; multi: boolean; sole: boolean }> = {
  "a.example.test": { tenant: a, multi: true, sole: false },
  "b.example.test": { tenant: b, multi: true, sole: false },
};
const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://core.test").pathname;
  res.setHeader("content-type", "application/json");
  const host = path.startsWith("/v1/operator/hosts/") ? decodeURIComponent(path.slice(19)) : undefined;
  if (host !== undefined)
    return void res.end(JSON.stringify(hosts[host] ?? { tenant: null, multi: true, sole: false }));
  req.resume();
  res.end(JSON.stringify({ path }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "tenant-origin-core-secret",
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

function cookie(tenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub: "viewer@example.test", org: "acme", auth: now, iat: now, exp: now + 600, t: tenant };
  return `portal_session=${seal(claims, sessionKey)}`;
}

function post(host: string, tenant: string, origin: string, site: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/sessions",
        headers: {
          host,
          cookie: cookie(tenant),
          origin,
          "sec-fetch-site": site,
          "content-type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

test("a tenant host accepts a same-origin write from its own origin", async () => {
  assert.equal(await post("a.example.test", a, "http://a.example.test", "same-origin"), 200);
});

test("a tenant host refuses writes from the deployment origin or another tenant", async () => {
  assert.equal(await post("a.example.test", a, "http://portal.test", "cross-site"), 403);
  assert.equal(await post("a.example.test", a, "http://b.example.test", "same-site"), 403);
});
