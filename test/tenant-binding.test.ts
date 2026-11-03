import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { withRequestTenant } from "../src/api/tenant-ingress.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { mintCapabilityToken, verifyCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { mintPortalIdentity, verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { openOAuthState, sealOAuthState } from "../src/connectors/oauth.ts";
import { boundTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { canonicalPayload, signedRequestHeaders, TENANT_HEADER } from "../plugins/chassis/src/source-auth-sign.ts";

const TENANT_A = "0d6f6f1e-5a3c-4a7e-9a52-3c1f0b8e2a11";
const TENANT_B = "7b2e9c44-1d8f-4f60-8e3b-5a9d2c7f4b22";
const SECRET = "tenant-binding-capability-secret-0123456789";
const IDENTITY = "tenant-binding-identity-secret-0123456789ab";
const claims = { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 };

function requestWith(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = headers;
  return req;
}

async function tenantSeenBy(
  headers: Record<string, string>,
  route: { auth: "source" | "public"; tenant?: "none" | "row" } = { auth: "source" },
) {
  let seen: string | undefined = "rejected";
  const req = requestWith(headers);
  const res = new ServerResponse(req);
  await withRequestTenant(req, res, route, SECRET, () => {
    seen = boundTenant();
  });
  return { seen, status: res.statusCode };
}

describe("tenant claims", () => {
  it("capability tokens carry the minting tenant", async () => {
    const token = await withTenant(TENANT_B, () => mintCapabilityToken(claims, SECRET));
    assert.equal((await verifyCapabilityToken(token, SECRET))?.tenant, TENANT_B);
    const unbound = await withoutTenant(() => mintCapabilityToken(claims, SECRET));
    assert.equal((await verifyCapabilityToken(unbound, SECRET))?.tenant, undefined);
    const forged = await mintSignedPayload({ ...claims, tenant: "not-a-tenant" }, SECRET);
    assert.equal(await verifyCapabilityToken(forged, SECRET), null);
  });

  it("a portal identity verifies only inside the tenant it names", async () => {
    const token = await mintPortalIdentity({ t: TENANT_A, p: "U1", exp: Date.now() + 60_000 }, IDENTITY);
    assert.equal((await withTenant(TENANT_A, () => verifyPortalIdentity(token, IDENTITY, Date.now())))?.p, "U1");
    assert.equal(await withTenant(TENANT_B, () => verifyPortalIdentity(token, IDENTITY, Date.now())), null);
    assert.equal(await withoutTenant(() => verifyPortalIdentity(token, IDENTITY, Date.now())), null);
  });

  it("OAuth state carries the tenant that started the flow", async () => {
    const state = { provider: "github", principalId: "U1", redirectUri: "https://example.test/cb" };
    const sealed = await withTenant(TENANT_A, () => sealOAuthState(state, { secret: SECRET }));
    assert.equal((await openOAuthState(sealed, { secret: SECRET, maxAgeMs: 60_000 })).tenant, TENANT_A);
  });

  it("signed requests cover the tenant header", async () => {
    const headers = await withTenant(TENANT_A, () => signedRequestHeaders(SECRET, "GET", "/v1/x", "", {}, 1));
    assert.equal(headers[TENANT_HEADER], TENANT_A);
    assert.notEqual(canonicalPayload("GET", "/v1/x", "", TENANT_A), canonicalPayload("GET", "/v1/x", "", TENANT_B));
  });
});

describe("request ingress", () => {
  it("binds the tenant of a verified capability token over any tenant header", async () => {
    const token = await withTenant(TENANT_B, () => mintCapabilityToken(claims, SECRET));
    assert.deepEqual(await tenantSeenBy({ [CAPABILITY_HEADER]: token, [TENANT_HEADER]: TENANT_A }), {
      seen: TENANT_B,
      status: 200,
    });
  });

  it("binds the signed tenant header and rejects malformed ones", async () => {
    assert.deepEqual(await tenantSeenBy({ [TENANT_HEADER]: TENANT_A }), { seen: TENANT_A, status: 200 });
    assert.deepEqual(await tenantSeenBy({ [TENANT_HEADER]: "nope" }), { seen: "rejected", status: 401 });
  });

  it("rejects public routes that name a tenant only in an unsigned header, and unverifiable tokens", async () => {
    assert.deepEqual(await tenantSeenBy({ [TENANT_HEADER]: TENANT_A }, { auth: "public" }), {
      seen: "rejected",
      status: 401,
    });
    assert.deepEqual(await tenantSeenBy({ [CAPABILITY_HEADER]: "garbage" }), { seen: "rejected", status: 401 });
  });

  it("lets listed routes in unbound so they can resolve their own tenant, binding any verified one", async () => {
    assert.deepEqual(await tenantSeenBy({}, { auth: "public", tenant: "none" }), { seen: undefined, status: 200 });
    assert.deepEqual(await tenantSeenBy({}, { auth: "source", tenant: "row" }), { seen: undefined, status: 200 });
    assert.deepEqual(await tenantSeenBy({ [TENANT_HEADER]: TENANT_A }, { auth: "source", tenant: "row" }), {
      seen: TENANT_A,
      status: 200,
    });
    assert.deepEqual(await tenantSeenBy({ [TENANT_HEADER]: TENANT_A }, { auth: "public", tenant: "row" }), {
      seen: undefined,
      status: 200,
    });
  });
});
