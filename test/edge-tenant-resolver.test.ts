import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { inResolvedTenant, setTenantResolver } from "../plugins/chassis/src/resolve-tenant.ts";
import { boundTenant } from "../plugins/chassis/src/tenant.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";

const TENANT_A = "3f1c7a52-9d4e-4b8a-a6f0-2c5e8d1b7a93";
const TENANT_B = "8a2d4c6e-1b3f-4a5c-9e7d-0f2b4d6a8c1e";

test("edge requests run under the tenant their host resolves to, sign it to core, and fail closed otherwise", async (t) => {
  const tenants: Record<string, string> = { "a.example.test": TENANT_A, "b.example.test": TENANT_B };
  setTenantResolver(async (req: IncomingMessage) => tenants[String(req.headers["x-site"])]);
  t.after(() => setTenantResolver(async () => undefined));
  let handled = 0;
  const server = createServer(
    (req, res) =>
      void inResolvedTenant(req, res, async () => {
        handled++;
        const signedTenant = signedHeaders("s".repeat(48), "GET", "/v1/x")["x-qm-tenant"] ?? "";
        res.end(JSON.stringify({ bound: boundTenant() ?? null, signedTenant }));
      }),
  );
  server.listen(0);
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const get = (host: string, path = "/") =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-site": host } }).then(async (r) => [
      r.status,
      await r.text(),
    ]);
  assert.deepEqual(await get("a.example.test"), [200, JSON.stringify({ bound: TENANT_A, signedTenant: TENANT_A })]);
  assert.deepEqual(await get("b.example.test"), [200, JSON.stringify({ bound: TENANT_B, signedTenant: TENANT_B })]);
  const [status] = await get("unknown.example.test");
  assert.equal(status, 503);
  assert.equal(handled, 2);
  assert.deepEqual(await get("unknown.example.test", "/healthz"), [
    200,
    JSON.stringify({ bound: null, signedTenant: "" }),
  ]);
});
