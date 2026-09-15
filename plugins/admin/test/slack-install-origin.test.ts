import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToSurface } from "../../portal/src/proxy.ts";

const core = createServer((_req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-origin-test-secret";
process.env.QM_SLACK_SERVICE_URL = "https://slack.example.com";
const { server: admin } = await import("../src/index.ts");
await new Promise<void>((resolve) => admin.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
const portal = createServer((req, res) => {
  res.setHeader("referrer-policy", "no-referrer");
  proxyToSurface(req, res, {
    upstreamBase,
    forwardPath: req.url ?? "/",
    search: "",
    cookieName: "admin",
    principal: "admin@example.com",
  });
});
await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
test.after(() => {
  portal.close();
  admin.close();
  core.close();
});

test("managed install shell preserves its origin policy through the portal and on direct revalidation", async () => {
  for (const path of ["/", "/connectors?launch=private-value"]) {
    const first = await fetch(`${base}${path}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("referrer-policy"), "strict-origin");
    assert.match(
      first.headers.get("content-security-policy") ?? "",
      /form-action 'self' https:\/\/slack.example.com https:\/\/slack.com/,
    );
    await first.text();
    const cached = await fetch(`${upstreamBase}${path}`, { headers: { "if-none-match": first.headers.get("etag")! } });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("referrer-policy"), "strict-origin");
  }
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.headers.get("referrer-policy"), "no-referrer");
  const api = await fetch(`${base}/api/nonexistent`);
  assert.equal(api.headers.get("referrer-policy"), "no-referrer");
});

test("unmanaged admin shell retains no-referrer", async () => {
  delete process.env.QM_SLACK_SERVICE_URL;
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  await response.text();
});
