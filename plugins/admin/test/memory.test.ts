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
    res.end(JSON.stringify({ scopeId: "org:acme", content: "# Memory\n" }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-memory-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/memory forwards to /v1/admin/memory with the scope + actor + signature", async () => {
  const r = await fetch(`${base}/api/memory?scope=org:acme`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/memory?scope=org:acme");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("PUT /api/memory forwards the body + scope to the core", async () => {
  const r = await fetch(`${base}/api/memory?scope=personal:U1`, {
    method: "PUT",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ content: "# Memory\n\n- edited" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "/v1/admin/memory?scope=personal:U1");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.deepEqual(JSON.parse(c.body), { content: "# Memory\n\n- edited" });
});

test("GET /api/memory/scopes (the notebook directory) forwards as a memory READ sub-path", async () => {
  const r = await fetch(`${base}/api/memory/scopes`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/memory/scopes");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("memory routes require a signed-in cookie → 401 when absent (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/memory?scope=org:acme`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/memory?scope=org:acme`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
