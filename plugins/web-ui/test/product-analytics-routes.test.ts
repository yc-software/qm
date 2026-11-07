import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "analytics-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
process.env.WEB_UI_ANALYTICS = JSON.stringify({
  module: "https://cdn.example.com/analytics.js",
  connect: ["https://events.example.com"],
  options: { key: "public" },
});
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

test("the SPA's CSP admits the configured analytics script and event origins", async () => {
  const csp = (await fetch(`${base}/connectors/oauth/test/callback`)).headers.get("content-security-policy")!;
  const directives = csp.split(";").map((directive) => directive.trim().split(/\s+/));
  assert.deepEqual(
    directives.find(([name]) => name === "connect-src"),
    ["connect-src", "'self'", "https://events.example.com"],
  );
  assert.deepEqual(
    directives.find(([name]) => name === "script-src"),
    ["script-src", "'self'", "'wasm-unsafe-eval'", "https://cdn.example.com"],
  );
});
