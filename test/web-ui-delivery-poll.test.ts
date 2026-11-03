import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const TENANT_A = "3f1c7a52-9d4e-4b8a-a6f0-2c5e8d1b7a93";
const TENANT_B = "8a2d4c6e-1b3f-4a5c-9e7d-0f2b4d6a8c1e";
let deliveriesStatus = 503;
let deliveries: unknown[] = [{ id: "d1", tenantId: TENANT_A, createdAt: 0, destination: { target: "web:nobody:t1" } }];
const acked: string[] = [];
const ackTenants: string[] = [];
const core = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://core");
  if (req.method === "GET" && url.pathname === "/v1/deliveries" && url.searchParams.get("type") === "web") {
    res.writeHead(deliveriesStatus, { "content-type": "application/json" });
    res.end(deliveriesStatus === 200 ? JSON.stringify({ deliveries }) : JSON.stringify({ error: "unavailable" }));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/v1/deliveries/")) {
    acked.push(url.pathname);
    ackTenants.push(String(req.headers["x-qm-tenant"]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
core.listen(0);
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "core-signing-secret".repeat(3);
process.env.WEB_UI_PRINCIPALS = "";
const { drainWebDeliveries } = await import("../plugins/web-ui/server/index.ts");

after(() => new Promise<void>((r) => core.close(() => r())));

test("web delivery poll warns once per outage and logs recovery", async (t) => {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(String(args[0]));
  t.mock.method(console, "warn", record);
  t.mock.method(console, "log", record);
  const pollLines = () => lines.filter((line) => line.includes("web delivery poll"));

  for (let i = 0; i < 3; i++) await drainWebDeliveries();
  assert.equal(pollLines().length, 1);
  assert.match(pollLines()[0]!, /^\[swallowed\] web-ui: web delivery poll.*http 503/);

  deliveriesStatus = 200;
  await drainWebDeliveries();
  await drainWebDeliveries();
  assert.deepEqual(pollLines().slice(1), ["[web-ui] web delivery poll recovered"]);
  assert.deepEqual(acked, ["/v1/deliveries/d1/ack", "/v1/deliveries/d1/ack"]);

  deliveriesStatus = 500;
  await drainWebDeliveries();
  assert.equal(pollLines().length, 3);
  assert.match(pollLines()[2]!, /http 500/);
});

test("web delivery poll acks each tenant's deliveries under that tenant", async () => {
  deliveriesStatus = 200;
  deliveries = [
    { id: "a1", tenantId: TENANT_A, createdAt: 0, destination: { target: "web:nobody:t1" } },
    { id: "b1", tenantId: TENANT_B, createdAt: 0, destination: { target: "web:nobody:t2" } },
  ];
  acked.length = 0;
  ackTenants.length = 0;
  await drainWebDeliveries();
  assert.deepEqual(acked, ["/v1/deliveries/a1/ack", "/v1/deliveries/b1/ack"]);
  assert.deepEqual(ackTenants, [TENANT_A, TENANT_B]);
});
