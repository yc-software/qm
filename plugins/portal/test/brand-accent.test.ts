import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const HOSTILE_ACCENT = "red;} :root{--x:url(https://evil/a)";
let surfaceConfigRequests = 0;

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url?.startsWith("/v1/surface-config")) {
    surfaceConfigRequests++;
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ branding: { accent: HOSTILE_ACCENT }, modelProviderConfigured: false }));
  }
  if (req.url === "/api/whoami") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: false }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "brand-accent-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "brand-accent-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server, connectErrorHtml } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const sessionKey = deriveKey("brand-accent-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat: now, exp: now + 28800 }, sessionKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
});

test("a hostile surface-config accent reaches the module but never the connect style block", async () => {
  const nav = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-member") },
    redirect: "manual",
  });
  assert.equal(nav.status, 503);
  assert.equal(surfaceConfigRequests > 0, true);

  const html = connectErrorHtml("This connect link has expired.");
  assert.match(html, /--brand:#4f46e5; --radius-md:10px;/);
  assert.equal(html.includes(HOSTILE_ACCENT), false);
  assert.equal(html.includes("evil"), false);
  assert.equal(html.match(/:root\{/g)?.length, 1);
});
