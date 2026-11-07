import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "browser-error-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
delete process.env.WEB_UI_ANALYTICS;
process.env.SENTRY_BROWSER_DSN = "https://public@sentry.example.com/1";
process.env.SENTRY_RELEASE = "release-1";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});

test("the SPA's CSP admits the browser error reporting origin", async () => {
  const csp = (await fetch(`${base}/connectors/oauth/test/callback`)).headers.get("content-security-policy")!;
  const directives = csp.split(";").map((directive) => directive.trim().split(/\s+/));
  assert.deepEqual(
    directives.find(([name]) => name === "connect-src"),
    ["connect-src", "'self'", "https://sentry.example.com"],
  );
});
