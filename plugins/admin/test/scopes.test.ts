import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; actor: string | null; signed: boolean }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ scopeId: "org:acme", scopes: [] }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-scopes-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/scopes (the scope directory) forwards to /v1/admin/scopes signed + attributed", async () => {
  const r = await fetch(`${base}/api/scopes`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/scopes");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/scopes/<id> still reaches the per-scope governance read", async () => {
  const r = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1)!.url, "/v1/admin/scopes/org%3Aacme");
});

test("GET /api/scopes/<id>/export forwards to the config-export endpoint, query intact", async () => {
  const r = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}/export?secrets=include`, {
    headers: { cookie: ADMIN },
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.url, "/v1/admin/scopes/org%3Aacme/export?secrets=include");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/resources forwards to the governable-resource manifest, signed + attributed", async () => {
  const r = await fetch(`${base}/api/resources`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/resources");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/connector-catalog forwards the live connector catalog signed + attributed", async () => {
  const r = await fetch(`${base}/api/connector-catalog`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/connectors/catalog");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("the scope directory requires a signed-in cookie → 401 (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/scopes`)).status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
