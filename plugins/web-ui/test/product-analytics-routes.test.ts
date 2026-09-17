import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

let coreStatus = 200;
const core = createServer((req, res) => {
  res.writeHead(coreStatus, { "content-type": "application/json" });
  if (req.url?.startsWith("/v1/approvals/approval-1?")) {
    res.end(
      JSON.stringify({
        request: {
          actor: { externalId: "alice@example.com" },
          conversation: { threadRef: "web:alice@example.com:default" },
          text: "private approval text",
        },
      }),
    );
    return;
  }
  res.end(JSON.stringify(req.url?.startsWith("/v1/turns") ? { runId: "accepted-run" } : {}));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "analytics-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
process.env.POSTHOG_API_KEY = "phc_test";
process.env.POSTHOG_HOST = "https://us.i.posthog.com";
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

test("analytics config is authenticated, company-scoped and omitted during impersonation", async () => {
  assert.equal((await fetch(`${base}/me`)).status, 401);
  const response = await fetch(`${base}/me`, { headers: headers() });
  const body = await response.json();
  assert.deepEqual(body.analytics, { apiKey: "phc_test", host: "https://us.i.posthog.com" });
  assert.equal(body.org, "acme");
  assert.equal(body.user, "alice@example.com");
  assert.equal((await (await fetch(`${base}/me`, { headers: headers("admin") })).json()).analytics, undefined);
  coreStatus = 503;
  assert.equal((await fetch(`${base}/me`, { headers: headers() })).status, 503);
});
