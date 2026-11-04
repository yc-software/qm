import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { configureTenantCaches } from "../src/api/tenant-ingress.ts";
import { withTenant } from "../src/tenants/context.ts";
import { hostRequest } from "./support/host-request.ts";
import {
  deliver,
  HOOK_SECRET,
  type Instance,
  operatorSigned,
  signed,
  skip,
  startTenantInstance,
  stopTenantInstance,
} from "./support/tenant-instance.ts";

function webhook(tenant: string) {
  return withTenant(tenant, () =>
    multi.built.app.createWebhook({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      action: "triage",
      verification: { scheme: "github", secret: `${HOOK_SECRET}-${tenant}` },
    }),
  );
}

const a = randomUUID();
const b = randomUUID();
let multi: Instance;

before(async () => {
  if (skip) return;
  multi = await startTenantInstance([a, b]);
  for (const [tenant, host] of [
    [a, "a.example.test"],
    [b, "b.example.test"],
  ] as const) {
    const path = `/v1/operator/tenants/${tenant}/hosts/${host}`;
    assert.equal((await operatorSigned(multi, "PUT", path)).status, 200);
  }
});

after(() => stopTenantInstance(multi));

describe("operator routes", { skip }, () => {
  it("map hosts, refuse a host owned by another tenant, and report lookups", async () => {
    assert.equal((await operatorSigned(multi, "PUT", `/v1/operator/tenants/${b}/hosts/a.example.test`)).status, 409);
    assert.equal(
      (await operatorSigned(multi, "PUT", `/v1/operator/tenants/${randomUUID()}/hosts/x.example.test`)).status,
      404,
    );
    assert.equal((await operatorSigned(multi, "PUT", `/v1/operator/tenants/${a}/hosts/not_a_host`)).status, 400);
    const unsigned = await hostRequest(
      `${multi.base}/v1/operator/tenants/${a}/hosts/evil.example.test`,
      "core.internal",
      {
        method: "PUT",
      },
    );
    assert.equal(unsigned.status, 401);
    const lookup = await signed(multi, "core.internal", "GET", "/v1/operator/hosts/a.example.test");
    assert.deepEqual(JSON.parse(lookup.text), { tenant: a, multi: true, sole: false });
    assert.equal((await signed(multi, "core.internal", "GET", "/v1/operator/tenants/not-a-uuid/hosts")).status, 400);
    assert.equal(
      (await signed(multi, "core.internal", "GET", `/v1/operator/tenants/${randomUUID()}/hosts`)).status,
      404,
    );
    assert.equal(
      (await operatorSigned(multi, "PATCH", `/v1/operator/tenants/${randomUUID()}/settings`, "{}")).status,
      404,
    );
    const listed = await signed(multi, "core.internal", "GET", `/v1/operator/tenants/${a}/hosts`);
    assert.deepEqual(JSON.parse(listed.text), { hosts: ["a.example.test"] });
  });

  it("set settings without echoing their values", async () => {
    const path = `/v1/operator/tenants/${a}/settings`;
    const body = JSON.stringify({ modelGatewayKey: "gateway-key-a" });
    const set = await operatorSigned(multi, "PATCH", path, body);
    assert.deepEqual(JSON.parse(set.text), { keys: ["modelGatewayKey"] });
    const bad = await operatorSigned(multi, "PATCH", path, JSON.stringify({ storageBucket: 7 }));
    assert.equal(bad.status, 400);
  });

  it("refuse tenant writes signed with the plugin-held source secret", async () => {
    const writes: Array<[string, string, string]> = [
      ["PUT", `/v1/operator/tenants/${b}/hosts/hijack.example.test`, ""],
      ["DELETE", `/v1/operator/tenants/${a}/hosts/a.example.test`, ""],
      ["PATCH", `/v1/operator/tenants/${b}/settings`, JSON.stringify({ modelGatewayKey: "stolen" })],
    ];
    for (const [method, path, body] of writes)
      assert.equal((await signed(multi, "core.internal", method, path, body)).status, 401, `${method} ${path}`);
    const lookup = await signed(multi, "core.internal", "GET", "/v1/operator/hosts/a.example.test");
    assert.deepEqual(JSON.parse(lookup.text), { tenant: a, multi: true, sole: false });
    const listed = await signed(multi, "core.internal", "GET", `/v1/operator/tenants/${b}/hosts`);
    assert.deepEqual(JSON.parse(listed.text), { hosts: ["b.example.test"] });
    const mapped = await operatorSigned(multi, "PUT", `/v1/operator/tenants/${b}/hosts/b2.example.test`);
    assert.equal(mapped.status, 200);
    const unmapped = await operatorSigned(multi, "DELETE", `/v1/operator/tenants/${b}/hosts/b2.example.test`);
    assert.equal(unmapped.status, 200);
  });

  it("refuse tenant writes when no operator secret is configured", async () => {
    const secret = "no-operator-core-signing-secret".repeat(2);
    const server = createServer(multi.built.app, {
      signingSecret: secret,
      replayDedupe: createPostgresReplayDedupe(testMigratedDatabaseUrl()),
      tenancy: multi.built.tenancy,
    });
    server.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const send = (method: string, path: string) =>
        hostRequest(`${base}${path}`, "core.internal", {
          method,
          headers: signedRequestHeaders(secret, method, path, "", { "content-type": "application/json" }),
        });
      assert.equal((await send("PUT", `/v1/operator/tenants/${b}/hosts/hijack.example.test`)).status, 503);
      assert.equal((await send("GET", "/v1/operator/hosts/a.example.test")).status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answer health probes on any host and refuse unknown hosts otherwise", async () => {
    assert.equal((await hostRequest(`${multi.base}/healthz`, "10.0.0.7")).status, 200);
    assert.equal((await hostRequest(`${multi.base}/readyz`, "10.0.0.7")).status, 200);
    assert.equal((await signed(multi, "stranger.example.test", "GET", "/v1/webhooks?viewer=U1")).status, 421);
  });
});

describe("routes that resolve their tenant from a stored row", { skip }, () => {
  it("deliver an incoming webhook to its own tenant from any host but another tenant's", async () => {
    const hookA = await webhook(a);
    const hookB = await webhook(b);
    const secretA = `${HOOK_SECRET}-${a}`;
    assert.equal((await deliver(multi, "hooks.example.test", hookA.id, secretA)).status, 202);
    assert.equal((await deliver(multi, "a.example.test", hookA.id, secretA)).status, 202);
    assert.equal((await deliver(multi, "b.example.test", hookA.id, secretA)).status, 404);
    assert.equal((await deliver(multi, "hooks.example.test", hookB.id, `${HOOK_SECRET}-${b}`)).status, 202);
    assert.equal((await deliver(multi, "hooks.example.test", "no-such-hook")).status, 404);
    assert.notEqual((await withTenant(a, () => multi.built.app.listWebhookEvents(hookA.id, "U1"))).length, 0);
    assert.deepEqual(await withTenant(b, () => multi.built.app.listWebhookEvents(hookA.id, "U1")), []);
  });

  it("finish an OAuth flow under the tenant that started it", async () => {
    const begin = (tenant: string) =>
      withTenant(tenant, () =>
        multi.built.oauthFlows.start({ provider: "github", principalId: "U1", redirectUri: "https://x.test/cb" }),
      );
    const callback = (host: string, state: string) =>
      hostRequest(`${multi.base}/v1/connectors/oauth/github/callback?code=c&state=${state}`, host);
    const flowA = await begin(a);
    assert.equal((await callback("b.example.test", flowA)).status, 404);
    const finished = await callback("oauth.example.test", flowA);
    assert.equal(finished.status, 400);
    assert.equal(JSON.parse(finished.text).error, "oauth_callback_failed");
    assert.equal((await callback("oauth.example.test", "no-such-flow")).status, 404);
  });

  it("read a share link only under its own tenant", async () => {
    const token = randomUUID();
    await multi.owner.query("INSERT INTO session_shares(tenant_id, id, json) VALUES ($1, $2, '{}')", [a, token]);
    multi.shareReads.length = 0;
    await signed(multi, "core.internal", "GET", `/v1/public-shares/${token}`, "", b);
    await signed(multi, "core.internal", "GET", `/v1/public-shares/${randomUUID()}`, "", b);
    assert.deepEqual(multi.shareReads, []);
    await signed(multi, "core.internal", "GET", `/v1/public-shares/${token}`, "", a);
    assert.deepEqual(multi.shareReads, [{ token, tenant: a }]);
  });

  it("serve an app subdomain under its deployment's tenant and 404 unknown or ambiguous names", async () => {
    await multi.owner.query(
      `INSERT INTO deployments(tenant_id, id, json) VALUES ($1, 'shop-a', '{}'), ($1, 'both', '{}'), ($2, 'both', '{}')`,
      [a, b],
    );
    assert.equal((await hostRequest(`${multi.base}/`, "shop-a.apps.example.test")).status, 503);
    assert.equal((await hostRequest(`${multi.base}/`, "missing.apps.example.test")).status, 404);
    assert.equal((await hostRequest(`${multi.base}/`, "both.apps.example.test")).status, 404);
  });
});

describe("tenant cache loads", { skip }, () => {
  it("answer 503 for a request whose tenant's caches failed to load", async (t) => {
    configureTenantCaches(() => Promise.reject(new Error("connection reset")));
    t.after(() => configureTenantCaches(undefined));
    t.mock.method(console, "error", () => undefined);
    const res = await signed(multi, "a.example.test", "GET", "/v1/sessions");
    assert.equal(res.status, 503);
  });
});
