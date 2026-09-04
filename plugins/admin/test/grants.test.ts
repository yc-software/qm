import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; actor: string | null; signed: boolean; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-grants-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("POST /api/grants forwards to the core with the actor + a source-auth signature", async () => {
  const r = await fetch(`${base}/api/grants`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ principalId: "U1", role: "org_admin", scopeId: "org:acme" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/grants");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.deepEqual(JSON.parse(c.body), { principalId: "U1", role: "org_admin", scopeId: "org:acme" });
});

test("DELETE /api/grants/:id forwards the path + query to the core", async () => {
  const r = await fetch(`${base}/api/grants/U1?scope=org:acme&role=org_admin`, {
    method: "DELETE",
    headers: { cookie: ADMIN },
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "DELETE");
  assert.ok(c.url.startsWith("/v1/admin/grants/U1"), `forwarded path: ${c.url}`);
  assert.ok(c.url.includes("role=org_admin"), `forwarded query: ${c.url}`);
  assert.equal(c.actor, "U-admin@acme");
});

test("GET /api/users forwards to /v1/admin/users", async () => {
  const r = await fetch(`${base}/api/users`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/users");
  assert.equal(c.actor, "U-admin@acme");
});

test("GET /api/keychain forwards to /v1/admin/keychain", async () => {
  const r = await fetch(`${base}/api/keychain`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/keychain");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("grants/users require a signed-in cookie → 401 when absent (no core hop)", async () => {
  const before = calls.length;
  assert.equal(
    (await fetch(`${base}/api/grants`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
      .status,
    401,
  );
  assert.equal((await fetch(`${base}/api/grants/U1?scope=org:acme&role=org_admin`, { method: "DELETE" })).status, 401);
  assert.equal((await fetch(`${base}/api/users`)).status, 401);
  assert.equal((await fetch(`${base}/api/keychain`)).status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
