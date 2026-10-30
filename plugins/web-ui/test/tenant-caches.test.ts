import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withTenant } from "../../../src/tenants/context.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { addDeliveryClient, connectedUsers, deliveryClientsOf } from "../server/delivery-clients.ts";
import { activeRuns, forgetRun, rememberRun } from "../server/active-runs.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const SECRET = "core-signing-secret".repeat(3);
const USER = "same@example.com";

let deliveryTenant = B;
const core = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://core");
  if (req.method === "GET" && url.pathname === "/v1/deliveries") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        tenant: deliveryTenant,
        deliveries: [{ id: "d1", createdAt: Date.now(), destination: { target: `web:${USER}:t1` } }],
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
core.listen(0);
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler, drainWebDeliveries } = await import("../server/index.ts");
const web = createServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

test("delivery clients are keyed by tenant and user", () => {
  const resA = {} as ServerResponse;
  const resB = {} as ServerResponse;
  const removeA = withTenant(A, () => addDeliveryClient(USER, resA));
  withTenant(B, () => addDeliveryClient(USER, resB));
  assert.deepEqual([...deliveryClientsOf(A, USER)], [resA]);
  assert.deepEqual([...deliveryClientsOf(B, USER)], [resB]);
  assert.deepEqual([...deliveryClientsOf(undefined, USER)], []);
  removeA();
  assert.deepEqual(connectedUsers(A), []);
  assert.deepEqual([...deliveryClientsOf(B, USER)], [resB]);
  assert.throws(() => addDeliveryClient(USER, resA), /No tenant is bound/);
});

test("active runs are tracked per tenant", () => {
  withTenant(A, () => rememberRun("r1", USER, "web:t1"));
  assert.deepEqual(
    withTenant(B, () => activeRuns(USER, "web:t1")),
    [],
  );
  withTenant(B, () => forgetRun("r1"));
  assert.deepEqual(
    withTenant(A, () => activeRuns(USER, "web:t1")),
    ["r1"],
  );
  assert.throws(() => activeRuns(USER, "web:t1"), /No tenant is bound/);
});

test("a web delivery reaches only the same tenant's connection for a shared email", async () => {
  const controller = new AbortController();
  const stream = await fetch(`${webBase}/api/deliveries/events`, {
    headers: {
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: USER, t: A, exp: Date.now() + 60_000 }, SECRET),
    },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      seen += decoder.decode(value, { stream: true });
    }
  })();
  while (!seen.includes(": open")) await new Promise((r) => setTimeout(r, 10));
  await drainWebDeliveries();
  await new Promise((r) => setTimeout(r, 100));
  assert.doesNotMatch(seen, /event: delivery/);
  deliveryTenant = A;
  await drainWebDeliveries();
  const deadline = Date.now() + 2_000;
  while (!seen.includes("event: delivery") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.match(seen, /event: delivery/);
  controller.abort();
  await pump;
});
