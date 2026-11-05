import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "session-replay-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
process.env.POSTHOG_API_KEY = "phc_test";
process.env.POSTHOG_HOST = "https://us.i.posthog.com";
process.env.POSTHOG_SESSION_REPLAY = "1";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = (imp?: string) => ({
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

test("session replay is advertised to signed-in viewers outside impersonation, with its config host allowed", async () => {
  const response = await fetch(`${base}/me`, { headers: headers() });
  assert.deepEqual((await response.json()).analytics, {
    apiKey: "phc_test",
    host: "https://us.i.posthog.com",
    sessionReplay: true,
  });
  const csp = (await fetch(`${base}/connectors/oauth/test/callback`)).headers.get("content-security-policy")!;
  assert.deepEqual(
    csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === "connect-src"),
    ["connect-src", "'self'", "https://us.i.posthog.com", "https://us-assets.i.posthog.com"],
  );
  assert.equal((await (await fetch(`${base}/me`, { headers: headers("admin") })).json()).analytics, undefined);
});
