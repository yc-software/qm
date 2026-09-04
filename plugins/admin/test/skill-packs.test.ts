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
process.env.CORE_SIGNING_SECRET = "admin-skill-packs-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("POST /api/skill-packs forwards the register body, actor, and signature", async () => {
  const r = await fetch(`${base}/api/skill-packs`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/x/y", ref: "main" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/skill-packs");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.deepEqual(JSON.parse(c.body), { url: "https://github.com/x/y", ref: "main" });
});

test("POST /api/skill-packs/:id/import forwards to the import endpoint", async () => {
  const r = await fetch(`${base}/api/skill-packs/s1/import`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ selected: "all" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/skill-packs/s1/import");
  assert.deepEqual(JSON.parse(c.body), { selected: "all" });
});

test("PATCH /api/skill-packs/:id forwards as PATCH", async () => {
  const r = await fetch(`${base}/api/skill-packs/s1`, {
    method: "PATCH",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ ref: "deadbeef" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PATCH");
  assert.equal(c.url, "/v1/admin/skill-packs/s1");
});

test("DELETE /api/skill-packs/:id forwards as DELETE with no body", async () => {
  const r = await fetch(`${base}/api/skill-packs/s1`, { method: "DELETE", headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "DELETE");
  assert.equal(c.url, "/v1/admin/skill-packs/s1");
  assert.equal(c.body, "");
});

test("GET /api/skill-packs/:id/catalog forwards as a read", async () => {
  const r = await fetch(`${base}/api/skill-packs/s1/catalog`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/skill-packs/s1/catalog");
});

test("POST /api/skill-packs/:id/sync forwards the force-sync", async () => {
  const r = await fetch(`${base}/api/skill-packs/s1/sync`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/skill-packs/s1/sync");
});

test("DELETE /api/skills/:id forwards as DELETE (per-skill un-index)", async () => {
  const r = await fetch(`${base}/api/skills/k1?scope=org:acme`, { method: "DELETE", headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "DELETE");
  assert.equal(c.url, "/v1/admin/skills/k1?scope=org:acme");
});

test("skill-pack writes require a signed-in cookie", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/skill-packs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
