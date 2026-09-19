import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createTenantContext, currentTenant } from "../src/tenancy/context.ts";
import { createHostServer, createTenantRouter } from "../src/tenancy/router.ts";

test("shared listener resolves before raw dispatch and rejects conflicting selectors", async (t) => {
  const dispatched: string[] = [];
  const server = createHostServer(
    createTenantRouter(
      ["alpha", "beta"].map((id) => ({
        context: createTenantContext({ id, env: {}, pooled: true }),
        hosts: [`${id}.example.test`],
        appsDomain: `${id}.apps.test`,
        listener(_req, res) {
          dispatched.push(currentTenant()!.id);
          res.end(id);
        },
      })),
      true,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const call = (headers: Record<string, string>, path = "/v1/blobs/same-id") =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path, headers },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (data: string) => {
            text += data;
          });
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.equal((await call({ host: "alpha.example.test" })).text, "alpha");
  assert.equal((await call({ host: "shared.internal", "x-qm-tenant": "beta" })).text, "beta");
  assert.equal((await call({ host: "published.alpha.apps.test" })).text, "alpha");
  const payload = Buffer.from(JSON.stringify({ orgId: "alpha" })).toString("base64url");
  const capability = `unverified.${payload}.hint`;
  assert.equal((await call({ host: "shared.internal", "x-agent-capability": capability })).text, "alpha");
  for (const authorization of [
    `Basic ${Buffer.from(`qm:${capability}`).toString("base64")}`,
    `Basic   ${Buffer.from(`${capability}:`).toString("base64")}`,
    `Bearer   ${capability}`,
  ]) {
    assert.equal(
      (await call({ host: "shared.internal", authorization }, "/v1/deployments/demo/git/info/refs")).text,
      "alpha",
    );
  }
  const before = dispatched.length;
  assert.equal((await call({ host: "alpha.example.test", "x-qm-tenant": "beta" })).status, 421);
  assert.equal((await call({ host: "beta.example.test", "x-agent-capability": capability })).status, 421);
  assert.equal((await call({ host: "unknown.example.test" })).status, 421);
  assert.equal((await call({ host: "alpha.example.test", "x-qm-tenant": "missing" })).status, 421);
  assert.equal(dispatched.length, before);
  assert.deepEqual(await call({ host: "shared.internal" }, "/healthz"), { status: 200, text: '{"ok":true}' });
});
