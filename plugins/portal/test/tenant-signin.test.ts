import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let settings: Record<string, string> | null = null;
const core = createServer((req, res) => {
  if (req.url?.startsWith("/v1/tenants/for-host"))
    return res.end(JSON.stringify({ tenant: "00000000-0000-4000-8000-000000000001" }));
  if (!req.url?.startsWith("/v1/plugin-settings")) return res.end("{}");
  res.statusCode = settings ? 200 : 503;
  res.end(JSON.stringify(settings ? { values: settings } : { error: "unavailable" }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://127.0.0.1:19994",
  PORTAL_SESSION_SECRET: "tenant-signin-fixture-secret-at-least-32-chars",
  CORE_ORG_ID: "tenant",
  CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  AUTH_BROKER_UPSTREAM: "",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

test("sign-in fails closed without the tenant's settings, then uses the ones core serves", async () => {
  const refused = await fetch(`${base}/auth/login`, { redirect: "manual" });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("location"), null);
  assert.equal(
    refused.headers.getSetCookie().some((c) => c.startsWith("portal_oidc_tmp=")),
    false,
  );
  assert.match(
    await refused.text(),
    /sign-in is not configured for this workspace: core refused the plugin settings read/,
  );

  settings = { OIDC_AUTH_ENDPOINT: "https://idp.example.test/authorize", OIDC_CLIENT_ID: "tenant-client" };
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get("location")!);
  assert.equal(location.origin, "https://idp.example.test");
  assert.equal(location.searchParams.get("client_id"), "tenant-client");
});
