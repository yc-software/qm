import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { startWithFakeCore, type CoreHit } from "./fake-core.ts";

let providerConfigured = false;

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url?.startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({ webuiModels: [], baseModel: "m", modelProviderConfigured: providerConfigured }),
    );
  }
  if (req.url?.startsWith("/v1/admin/whoami")) {
    res.writeHead(200, { "content-type": "application/json" });
    const actor = req.headers["x-admin-actor"];
    if (actor === "U-admin@acme") return void res.end(JSON.stringify({ isAdmin: true, role: "org_admin" }));
    if (actor === "U-owner@acme") return void res.end(JSON.stringify({ isAdmin: true, role: "owner" }));
    return void res.end(JSON.stringify({ isAdmin: false }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PUBLIC_WEB_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "onboarding-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "onboarding-test-core-secret";
process.env.CORE_API_URL = upstreamUrl;

const { deriveKey, seal } = await import("../src/session.ts");
const { base, close } = await startWithFakeCore();

const sessionKey = deriveKey("onboarding-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat: now, exp: now + 28800 }, sessionKey))}`;
}

test.after(() => {
  close();
  upstream.close();
});

test("unconfigured deployment: admin HTML navigation redirects to settings onboarding", async () => {
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
    redirect: "manual",
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/settings/onboarding");
});

test("unconfigured deployment: non-admin HTML navigation gets a not-set-up page, not a bare 403", async () => {
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-member") },
    redirect: "manual",
  });
  assert.equal(r.status, 503);
  assert.match(await r.text(), /isn&#39;t set up yet/);
});

test("unconfigured deployment: web-ui JSON requests still reach core untouched", async () => {
  const r = await fetch(`${base}/api/sessions`, { headers: { cookie: sessionCookie("U-admin") } });
  assert.equal(r.status, 200);
  const hit = (await r.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.url, "/api/sessions");
});

test("unconfigured deployment: settings pages reach the web UI, so onboarding never loops", async () => {
  for (const path of ["/settings/onboarding", "/settings"]) {
    const r = await fetch(`${base}${path}`, {
      headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
      redirect: "manual",
    });
    assert.equal(r.status, 200, path);
    const hit = (await r.json()) as CoreHit;
    assert.equal(hit.lane, "shell", path);
    assert.equal(hit.url, path);
  }
});

test("owner role reaches onboarding redirect when unconfigured and is refused impersonation", async () => {
  const redirectRes = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-owner") },
    redirect: "manual",
  });
  assert.equal(redirectRes.status, 302);
  assert.equal(redirectRes.headers.get("location"), "/settings/onboarding");

  const impRes = await fetch(`${base}/auth/impersonate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://portal.test",
      cookie: sessionCookie("U-owner"),
    },
    body: JSON.stringify({ target: "U-member" }),
  });
  assert.equal(impRes.status, 403);
});

test("once a provider is configured, admin HTML navigation reaches the web UI again", async () => {
  providerConfigured = true;
  await new Promise((r) => setTimeout(r, 5_200));
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
    redirect: "manual",
  });
  assert.equal(r.status, 200);
  const hit = (await r.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.url, "/");
});
