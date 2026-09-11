import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";

const identitySecret = "combined-admin-identity-secret-0123456789";
const calls: Array<{ actor: string | undefined; principal: string | undefined; path: string }> = [];
const core = createServer((req, res) => {
  const raw = req.headers["x-portal-identity"];
  const token = typeof raw === "string" ? raw : "";
  const principal = verifyPortalIdentity(token, identitySecret, Date.now())?.p;
  const actor = req.headers["x-admin-actor"] as string | undefined;
  const path = new URL(req.url!, "http://core").pathname;
  calls.push({ actor, principal, path });
  res.setHeader("content-type", "application/json");
  if (path === "/v1/admin/whoami") {
    res.end(JSON.stringify({ isAdmin: principal === "admin@example.com", principal }));
    return;
  }
  res.statusCode = principal === "admin@example.com" ? 200 : 403;
  res.end(JSON.stringify({ principal }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "combined-admin-core-secret-0123456789";
process.env.PORTAL_IDENTITY_SECRET = identitySecret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
process.env.ADMIN_ENABLED = "1";
const { handler } = await import("../server/index.ts");
const server = createServer((req, res) => {
  handler(req, res).catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  core.close();
});

const headers = (principal: string) => ({
  "x-portal-identity": mintPortalIdentity({ p: principal, exp: Date.now() + 60_000 }, identitySecret),
});

test("combined admin rejects a forged admin cookie before calling a privileged core API", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/admin/api/scopes`, { headers: { cookie: "admin=admin@example.com" } });
  assert.equal(response.status, 401);
  assert.equal(calls.slice(before).filter((entry) => entry.path.startsWith("/v1/admin/")).length, 0);
});

test("combined admin preserves authorization and request-local identity", async () => {
  const before = calls.length;
  const results = await Promise.all(
    ["admin@example.com", "member@example.com"].map(async (principal) => {
      const response = await fetch(`${base}/admin/api/scopes`, { headers: headers(principal) });
      await response.text();
      return response.status;
    }),
  );
  assert.deepEqual(results, [200, 403]);
  const privileged = calls.slice(before).filter((entry) => entry.path === "/v1/admin/scopes");
  assert.equal(privileged.length, 2);
  for (const call of privileged) {
    assert.equal(call.actor, `${call.principal}@acme`);
    assert.equal(call.path, "/v1/admin/scopes");
  }
});

test("admin whoami is reachable at the mounted path", async () => {
  const response = await fetch(`${base}/admin/api/whoami`, { headers: headers("admin@example.com") });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).isAdmin, true);
});
