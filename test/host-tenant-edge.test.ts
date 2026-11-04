import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inHostTenant, type HostTenantLookup } from "../plugins/chassis/src/host-tenant.ts";
import { boundTenant } from "../plugins/chassis/src/tenant.ts";
import { hostRequest } from "./support/host-request.ts";

const A = "3f1c7a52-9d4e-4b8a-a6f0-2c5e8d1b7a93";

async function edge(lookup: HostTenantLookup, refuseUnknown = true): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    void inHostTenant(
      lookup,
      req,
      res,
      async () => {
        res.end(boundTenant() ?? "unbound");
      },
      refuseUnknown,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the portal edge binds a mapped host, refuses unknown hosts once hosts are mapped, and passes probes", async () => {
  const { server, base } = await edge(async (host) =>
    host === "a.example.test" ? { tenant: A, multi: true } : { multi: true },
  );
  try {
    assert.equal((await hostRequest(`${base}/x`, "a.example.test:443")).text, A);
    assert.equal((await hostRequest(`${base}/x`, "stranger.example.test")).status, 421);
    assert.equal((await hostRequest(`${base}/healthz`, "stranger.example.test")).text, "unbound");
  } finally {
    server.close();
  }
});

test("a single-tenant edge binds the sole tenant, or runs unbound when the core reports none", async () => {
  const sole = await edge(async () => ({ tenant: A, multi: false }));
  const none = await edge(async () => ({ multi: false }));
  const lenient = await edge(async () => ({ multi: true }), false);
  try {
    assert.equal((await hostRequest(`${sole.base}/x`, "anything.example.test")).text, A);
    assert.equal((await hostRequest(`${none.base}/x`, "anything.example.test")).text, "unbound");
    assert.equal((await hostRequest(`${lenient.base}/x`, "auth.example.test")).text, "unbound");
  } finally {
    for (const { server } of [sole, none, lenient]) server.close();
  }
});
