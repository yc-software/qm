import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import type { DesignSystems } from "../src/design-system/design-systems.ts";

const secret = "design-system-route-test-secret".repeat(2);

test("design selections require authenticated identity; only admins set org defaults", async (t) => {
  const calls: Array<unknown[]> = [];
  const service = {
    state: async (actor: string) => ({ actor }),
    select: async (...args: unknown[]) => {
      calls.push(args);
    },
    create: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as DesignSystems;
  const admin = {
    listGrants: async () => [{ principalId: "alice", scopeId: "org:default-org", role: "org_admin" }],
    resolveActor: (raw: string) => ({ id: raw.split("@")[0], type: "internal" }),
  } as ServerDeps["admin"];
  const server = createServer({} as App, {
    signingSecret: secret,
    portalIdentitySecret: secret,
    designSystems: service,
    admin,
  });
  await new Promise<void>((r) => server.listen(0, r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let nonce = 0;
  async function request(path: string, actor?: string, body: unknown = { deploymentId: "app1" }) {
    path += `?nonce=${++nonce}`;
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(secret, ts, `PUT\n${path}\n${raw}`),
        ...(actor
          ? { "x-portal-identity": await mintPortalIdentity({ p: actor, exp: Date.now() + 60000 }, secret) }
          : {}),
      },
      body: raw,
    });
  }
  assert.equal((await request("/v1/design-system")).status, 401);
  assert.equal(
    (await request("/v1/design-system", "bob", { deploymentId: "app1", actor: "alice", scope: "org:default-org" }))
      .status,
    200,
  );
  assert.deepEqual(calls.pop(), ["personal", "bob", "app1"]);
  assert.equal((await request("/v1/admin/design-system", "bob")).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request("/v1/admin/design-system", "alice")).status, 200);
  assert.deepEqual(calls.pop(), ["org", "alice", "app1"]);
  assert.equal((await request("/v1/design-system", "bob", { deploymentId: { id: "app1" } })).status, 400);
  assert.equal((await request("/v1/design-system", "bob", { deploymentId: null })).status, 200);
  assert.deepEqual(calls.pop(), ["personal", "bob", null]);
  assert.equal(
    (
      await fetch(base + "/v1/design-system", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: '{"deploymentId":null}',
      })
    ).status,
    401,
  );
});
