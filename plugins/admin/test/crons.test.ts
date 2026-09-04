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
process.env.CORE_SIGNING_SECRET = "admin-crons-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("PUT /api/crons/:id/destination forwards the body + scope to the core", async () => {
  const r = await fetch(`${base}/api/crons/c1/destination?scope=personal:U1`, {
    method: "PUT",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ destination: { type: "slack", target: "D1", audienceScopeId: "personal:U1" } }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "/v1/admin/crons/c1/destination?scope=personal:U1");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.deepEqual(JSON.parse(c.body), {
    destination: { type: "slack", target: "D1", audienceScopeId: "personal:U1" },
  });
});

test("cron destination writes require a signed-in cookie", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/crons/c1/destination?scope=personal:U1`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: null }),
  });
  assert.equal(r.status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
