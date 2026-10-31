import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, request, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { withRowTenant } from "../src/api/tenant-ingress.ts";
import { mintCapabilityToken, verifyCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { mintPortalIdentity, verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { currentTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { memoryTenants, singleTenantResolver } from "../src/tenants/resolver.ts";
import { signedRequestHeaders, TENANT_HEADER } from "../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { OTHER_TENANT, TEST_TENANT } from "./support/tenant.ts";

const SOURCE = "tenant-binding-source-secret-0123456789abcdef";
const IDENTITY = "tenant-binding-identity-secret-0123456789ab";
const HOSTS: Record<string, string> = { "a.example": TEST_TENANT, "b.example": OTHER_TENANT };

describe("tenant resolution", () => {
  it("the single-tenant resolver answers only when exactly one tenant exists", async () => {
    assert.equal(await singleTenantResolver(async () => [TEST_TENANT]).forHost("any.example"), TEST_TENANT);
    assert.equal(await singleTenantResolver(async () => [TEST_TENANT]).forSlackTeam("T1"), TEST_TENANT);
    assert.equal(await singleTenantResolver(async () => []).forHost("any.example"), null);
    assert.equal(await singleTenantResolver(async () => [TEST_TENANT, OTHER_TENANT]).forHost("a.example"), null);
    const [memory] = await memoryTenants();
    assert.deepEqual(await memoryTenants(), [memory]);
  });

  it("an owner row lookup binds the row's tenant and refuses unknown or ambiguous rows", async () => {
    const rows: Record<string, string[]> = { one: [OTHER_TENANT], none: [], both: [TEST_TENANT, OTHER_TENANT] };
    const statuses: Record<string, number> = {};
    for (const id of Object.keys(rows)) {
      let seen: string | undefined;
      const res = new ServerResponse(new IncomingMessage(new Socket()));
      await withRowTenant(
        res,
        async (_table, _columns, value) => rows[value]!,
        { table: "webhooks", columns: ["id"], id },
        () => {
          seen = currentTenant();
        },
      );
      statuses[id] = seen ? 200 : res.statusCode;
      if (seen) assert.equal(seen, OTHER_TENANT);
    }
    assert.deepEqual(statuses, { one: 200, none: 404, both: 404 });
  });

  it("a portal identity only verifies inside the tenant it names", async () => {
    const token = await mintPortalIdentity({ t: TEST_TENANT, p: "U1", exp: Date.now() + 60_000 }, IDENTITY);
    assert.equal((await withTenant(TEST_TENANT, () => verifyPortalIdentity(token, IDENTITY, Date.now())))?.p, "U1");
    assert.equal(await withTenant(OTHER_TENANT, () => verifyPortalIdentity(token, IDENTITY, Date.now())), null);
    assert.equal(await verifyPortalIdentity(token, IDENTITY, Date.now()), null);
    const tenantless = await mintSignedPayload({ p: "U1", exp: Date.now() + 60_000 }, IDENTITY);
    assert.equal(await withTenant(TEST_TENANT, () => verifyPortalIdentity(tenantless, IDENTITY, Date.now())), null);
  });

  it("capability tokens carry the minting tenant and tokens without one are refused", async () => {
    const claims = { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 };
    await assert.rejects(() => mintCapabilityToken(claims, TEST_CAPABILITY_SECRET), /No tenant is bound/);
    const token = await withTenant(OTHER_TENANT, () => mintCapabilityToken(claims, TEST_CAPABILITY_SECRET));
    assert.equal((await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET))?.tenant, OTHER_TENANT);
    const tenantless = await mintSignedPayload(claims, TEST_CAPABILITY_SECRET);
    assert.equal(await verifyCapabilityToken(tenantless, TEST_CAPABILITY_SECRET), null);
  });
});

describe("core ingress binds the verified tenant", () => {
  let server: Server;
  let port: number;

  before(async () => {
    const built = buildApp(testConfig());
    server = createServer(built.app, {
      signingSecret: SOURCE,
      capabilitySecret: TEST_CAPABILITY_SECRET,
      portalIdentitySecret: IDENTITY,
      scheduler: built.scheduler,
      identity: built.identity,
      config: built.config,
      tenants: { forHost: async (host) => HOSTS[host] ?? null, forSlackTeam: async () => null },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (host: string, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: { message?: string } }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { ...headers, host } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as { message?: string } }));
      });
      req.on("error", reject);
      req.end();
    });

  it("refuses a signed request that names no tenant", async () => {
    const { status, body } = await call(
      "a.example",
      "/v1/surface-config",
      withoutTenant(() => signedRequestHeaders(SOURCE, "GET", "/v1/surface-config")),
    );
    assert.equal(status, 401);
    assert.match(body.message ?? "", /no verifiable tenant/);
  });

  it("serves a signed request inside the tenant it names", async () => {
    const headers = signedRequestHeaders(SOURCE, "GET", "/v1/surface-config", "", { [TENANT_HEADER]: TEST_TENANT });
    assert.equal((await call("a.example", "/v1/surface-config", headers)).status, 200);
  });

  it("refuses a tenant header the signature does not cover", async () => {
    const headers = signedRequestHeaders(SOURCE, "GET", "/v1/surface-config", "", { [TENANT_HEADER]: TEST_TENANT });
    const forged = { ...headers, [TENANT_HEADER]: OTHER_TENANT };
    const { status, body } = await call("b.example", "/v1/surface-config", forged);
    assert.equal(status, 401);
    assert.match(body.message ?? "", /signature mismatch/);
  });

  it("refuses a credential from tenant A on tenant B's host", async () => {
    const headers = signedRequestHeaders(SOURCE, "GET", "/v1/surface-config", "", { [TENANT_HEADER]: TEST_TENANT });
    const { status, body } = await call("b.example", "/v1/surface-config", headers);
    assert.equal(status, 403);
    assert.match(body.message ?? "", /another tenant/);
    const token = await withTenant(TEST_TENANT, () =>
      mintCapabilityToken(
        { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
        TEST_CAPABILITY_SECRET,
      ),
    );
    const capability = await call("b.example", "/v1/runs/nope", { "x-agent-capability": token });
    assert.equal(capability.status, 403);
    assert.match(capability.body.message ?? "", /another tenant/);
  });

  it("requires a portal identity on person routes even with a valid signature", async () => {
    const path = "/v1/runs/nope";
    const headers = signedRequestHeaders(SOURCE, "GET", path, "", { [TENANT_HEADER]: TEST_TENANT });
    const unsigned = await call("a.example", path, headers);
    assert.equal(unsigned.status, 401);
    assert.match(unsigned.body.message ?? "", /portal identity required/);
  });
});
