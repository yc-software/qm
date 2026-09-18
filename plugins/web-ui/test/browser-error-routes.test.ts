import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

let coreStatus = 200;
const core = createServer((req, res) => {
  res.writeHead(coreStatus, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "browser-error-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
delete process.env.POSTHOG_API_KEY;
process.env.SENTRY_BROWSER_DSN = "https://public@sentry.example.com/1";
process.env.SENTRY_RELEASE = "release-1";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = (imp?: string) => ({
  "content-type": "application/json",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: "alice@example.com", exp: Date.now() + 60_000, ...(imp ? { imp } : {}) },
    secret,
  ),
});

test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});

test("browser error config requires authentication and excludes impersonation", async () => {
  assert.equal((await fetch(`${base}/me`)).status, 401);
  const response = await fetch(`${base}/me`, { headers: headers() });
  const body = await response.json();
  assert.deepEqual(body.browserErrors, { dsn: "https://public@sentry.example.com/1", release: "release-1" });
  const csp = (await fetch(`${base}/connectors/oauth/test/callback`)).headers.get("content-security-policy")!;
  const connectSrc = csp.split(";").map((directive) => directive.trim().split(/\s+/));
  assert.deepEqual(
    connectSrc.find(([name]) => name === "connect-src"),
    ["connect-src", "'self'", "https://sentry.example.com"],
  );
  assert.equal((await (await fetch(`${base}/me`, { headers: headers("admin") })).json()).browserErrors, undefined);
  coreStatus = 503;
  assert.equal((await fetch(`${base}/me`, { headers: headers() })).status, 503);
});
