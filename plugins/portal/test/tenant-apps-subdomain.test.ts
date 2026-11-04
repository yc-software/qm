import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";
import { parseTenantAppHost, tenantAppsSubdomain } from "../src/tenant-apps.ts";

const secret = "tenant-apps-test-secret";
const sessionKey = deriveKey(secret, "portal.session.v1");
const a = randomUUID();
const b = randomUUID();
const hosts: Record<string, { tenant: string; multi: boolean; sole: boolean }> = {
  "a.example.test": { tenant: a, multi: true, sole: false },
  "b.example.test": { tenant: b, multi: true, sole: false },
  "notes.apps.b.example.test": { tenant: a, multi: true, sole: false },
};
const coreSeen: Array<{ host?: string; appHost?: string; path?: string }> = [];
const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://core.test").pathname;
  res.setHeader("content-type", "application/json");
  const host = path.startsWith("/v1/operator/hosts/") ? decodeURIComponent(path.slice(19)) : undefined;
  if (host !== undefined)
    return void res.end(JSON.stringify(hosts[host] ?? { tenant: null, multi: true, sole: false }));
  const appHost = req.headers["x-qm-app-host"];
  coreSeen.push({
    ...(req.headers.host ? { host: req.headers.host } : {}),
    ...(typeof appHost === "string" ? { appHost } : {}),
    path,
  });
  res.end(JSON.stringify({ path }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "tenant-apps-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
  PORTAL_APPS_TENANT_SUBDOMAIN: "apps",
});
delete process.env.PORTAL_APPS_DOMAIN;
delete process.env.DEPLOY_APPS_DOMAIN;
delete process.env.PORTAL_COOKIE_DOMAIN;
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
test.after(() => {
  server.close();
  upstream.close();
});

function session(tenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    k: "session",
    sub: "viewer@example.test",
    org: "acme",
    auth: now,
    iat: now,
    exp: now + 600,
    t: tenant,
  };
  return `portal_session=${seal(claims, sessionKey)}`;
}

function send(
  host: string,
  path: string,
  opts: { method?: string; cookie?: string; origin?: string } = {},
): Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: {
          host,
          accept: "application/json",
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.origin ? { origin: opts.origin } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, cookies: res.headers["set-cookie"] ?? [] }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("an app host under a tenant's own host goes to core's app gateway, host intact", async () => {
  coreSeen.length = 0;
  const res = await send("notes.apps.a.example.test", "/page");
  assert.equal(res.status, 200);
  assert.deepEqual(coreSeen, [{ host: "notes.apps.a.example.test", appHost: "1", path: "/page" }]);
});

test("an app host under no known tenant is refused without reaching core", async () => {
  coreSeen.length = 0;
  assert.equal((await send("notes.apps.unknown.example.test", "/page")).status, 404);
  assert.equal((await send("apps.a.example.test", "/page")).status, 421);
  assert.deepEqual(coreSeen, []);
});

test("signing out on a tenant host clears the cookie scoped to that tenant's host only", async () => {
  const res = await send("a.example.test", "/auth/logout", {
    method: "POST",
    cookie: session(a),
    origin: "http://a.example.test",
  });
  assert.equal(res.status, 200);
  const cleared = res.cookies.filter((c) => c.startsWith("portal_session="));
  assert.ok(cleared.some((c) => /;\s*Domain=a\.example\.test/i.test(c)));
  assert.ok(cleared.every((c) => !/Domain=(\.)?example\.test(;|$)/i.test(c)));
});

test("tenant app hosts parse into the app and the tenant host, nothing looser", () => {
  assert.deepEqual(parseTenantAppHost("notes.apps.a.example.test", "apps"), {
    app: "notes",
    tenantHost: "a.example.test",
  });
  assert.deepEqual(parseTenantAppHost("Notes.APPS.a.example.test:443", "apps"), {
    app: "notes",
    tenantHost: "a.example.test",
  });
  assert.equal(parseTenantAppHost("apps.a.example.test", "apps"), undefined);
  assert.equal(parseTenantAppHost("a.b.apps.a.example.test", "apps"), undefined);
  assert.equal(parseTenantAppHost("notes.apps.localhost", "apps"), undefined);
  assert.equal(tenantAppsSubdomain(" Apps "), "apps");
  assert.throws(() => tenantAppsSubdomain("apps.x"));
});

test("a host that is one tenant's web host and another tenant's app host is refused, never served as either", async () => {
  const before = coreSeen.length;
  const res = await send("notes.apps.b.example.test", "/");
  assert.equal(res.status, 404);
  assert.equal(coreSeen.slice(before).filter((c) => c.appHost || c.path === "/").length, 0, "nothing proxied");
});
