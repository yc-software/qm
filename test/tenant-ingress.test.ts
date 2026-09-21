import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { createRequestListener } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import type { BlobTransferStore } from "../src/persistence/blob-transfer.ts";
import type { ServiceCredentialStore } from "../src/credentials/keychain.ts";
import type { SecretDropStore } from "../src/credentials/secret-drop.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { mintCapabilityToken, verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { mintPortalIdentity, verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { signedRequestHeaders as coreSignedHeaders } from "../src/auth/source-auth-sign.ts";
import { signedHeaders, fetchCoreText } from "../plugins/chassis/src/core-client.ts";
import {
  mintPortalIdentity as mintPluginIdentity,
  verifyPortalIdentity as verifyPluginIdentity,
} from "../plugins/chassis/src/portal-identity.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";

const SOURCE = "same-source-secret-across-tenant-tests-0001";
const CAPABILITY = "same-capability-secret-across-tenants-0001";
const PORTAL = "same-portal-identity-across-tenants-0001";

async function start(t: TestContext, tenantId: string): Promise<string> {
  const app = {
    pendingDeliveries: async () => [{ id: tenantId }],
    getSessionForViewer: async () => null,
    authorizesCapabilityScope: async () => true,
    reachDeployment: async () => ({ ok: false, reason: "not_found" }),
    subscribeSessionStates: () => () => {},
    subscribeLedgerEvents: () => () => {},
  } as unknown as App;
  const listener = createRequestListener(app, {
    tenantId,
    requireTenantBinding: true,
    signingSecret: SOURCE,
    capabilitySecret: CAPABILITY,
    portalIdentitySecret: PORTAL,
    blobTransfer: {
      open: async () => ({ sizeBytes: tenantId.length, stream: Readable.from([tenantId]) }),
    } as unknown as BlobTransferStore,
    serviceCreds: {
      getServiceCredentialSecret: async () => null,
    } as unknown as ServiceCredentialStore,
    secretDrops: {
      peek: async () => ({
        ok: true,
        rec: { requiresToken: true, ownerId: "U1", service: "test-service", purpose: "test-purpose" },
      }),
    } as unknown as SecretDropStore,
  });
  const server: Server = createHttpServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("tenant source signatures cannot be moved between runtimes sharing a key", async (t) => {
  const alpha = await start(t, "alpha");
  const beta = await start(t, "beta");
  const path = "/v1/deliveries?type=slack";
  const alphaHeaders = signedHeaders(SOURCE, "GET", path, "", "", "alpha");
  assert.equal((await fetch(`${alpha}${path}`, { headers: alphaHeaders })).status, 200);
  assert.equal((await fetch(`${beta}${path}`, { headers: alphaHeaders })).status, 401);
  assert.equal((await fetch(`${beta}${path}`, { headers: { ...alphaHeaders, "x-qm-tenant": "beta" } })).status, 401);
  const legacy = signedHeaders(SOURCE, "GET", path);
  assert.equal((await fetch(`${beta}${path}`, { headers: legacy })).status, 401);
  assert.equal((await fetch(`${beta}${path}`, { headers: { ...legacy, "x-qm-tenant": "beta" } })).status, 401);
  assert.equal((await fetch(`${beta}/healthz`, { headers: { "x-qm-tenant": "beta,alpha" } })).status, 401);
  const response = await fetchCoreText({ origin: beta, secret: SOURCE, tenantId: "beta", method: "GET", path });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { deliveries: [{ id: "beta" }] });
});

test("raw stream routes require the tenant in their source signatures", async (t) => {
  const beta = await start(t, "beta");
  for (const path of ["/v1/session-state/events", "/v1/loop-items/events"]) {
    assert.equal((await fetch(`${beta}${path}`, { headers: signedHeaders(SOURCE, "GET", path) })).status, 401);
    const headers = signedHeaders(SOURCE, "GET", path, "", "", "alpha");
    assert.equal((await fetch(`${beta}${path}`, { headers: { ...headers, "x-qm-tenant": "beta" } })).status, 401);
    const response = await fetch(`${beta}${path}`, {
      headers: signedHeaders(SOURCE, "GET", path, "", "", "beta"),
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
});

test("capabilities require matching tenant claims on API and raw blob paths", async (t) => {
  const beta = await start(t, "beta");
  const claims = { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + 60_000 };
  for (const orgId of [undefined, "alpha", "beta"]) {
    const token = await mintSignedPayload({ ...claims, orgId }, CAPABILITY);
    const response = await fetch(`${beta}/v1/admin/whoami`, { headers: { "x-agent-capability": token } });
    assert.equal(response.status, orgId === "beta" ? 404 : 401);
    const blobId = "a".repeat(32);
    const blobToken = await mintSignedPayload(
      { ...claims, orgId, aud: "blob-transfer", blob: { dir: "read", id: blobId } },
      CAPABILITY,
    );
    const blob = await fetch(`${beta}/v1/blobs/${blobId}`, { headers: { "x-agent-capability": blobToken } });
    assert.equal(blob.status, orgId === "beta" ? 200 : 403);
    if (blob.ok) assert.equal(await blob.text(), "beta");
    const gitToken = await mintSignedPayload(
      { ...claims, orgId, aud: "credential-broker", credentials: ["git-service"] },
      CAPABILITY,
    );
    const git = await fetch(`${beta}/v1/credentials/git/git-service/repo/info/refs`, {
      headers: { "x-agent-capability": gitToken },
    });
    assert.equal(git.status, orgId === "beta" ? 404 : 401);
  }
});

test("secret-drop query tokens are tenant bound independently of source and portal credentials", async (t) => {
  const beta = await start(t, "beta");
  const identity = await mintSignedPayload({ p: "U1", orgId: "beta", exp: Date.now() + 60_000 }, PORTAL);
  for (const orgId of [undefined, "alpha", "beta"]) {
    const token = await mintSignedPayload(
      { actorId: "U1", scopeId: "personal:U1", orgId, aud: "secret-drop", drop: "drop1", exp: Date.now() + 60_000 },
      CAPABILITY,
    );
    const path = `/v1/keychain/drops/drop1/form?t=${encodeURIComponent(token)}`;
    const response = await fetch(`${beta}${path}`, {
      headers: {
        ...signedHeaders(SOURCE, "GET", path, "", "", "beta"),
        "x-portal-identity": identity,
        "x-drop-owner": "U1",
      },
    });
    assert.equal(response.status, orgId === "beta" ? 200 : 404);
  }
});

test("portal identities require tenant claims even when the source signature matches", async (t) => {
  const beta = await start(t, "beta");
  const path = "/v1/sessions/missing?viewer=U1";
  for (const orgId of [undefined, "alpha", "beta"]) {
    const token = await mintSignedPayload({ p: "U1", orgId, exp: Date.now() + 60_000 }, PORTAL);
    const response = await fetch(`${beta}${path}`, {
      headers: { ...signedHeaders(SOURCE, "GET", path, "", "", "beta"), "x-portal-identity": token },
    });
    assert.equal(response.status, orgId === "beta" ? 404 : 401);
    if (orgId !== "beta") {
      const rawPath = "/d/missing/";
      const raw = await fetch(`${beta}${rawPath}`, {
        headers: {
          ...signedHeaders(SOURCE, "GET", rawPath, "", "U1", "beta"),
          "x-as-principal": "U1",
          "x-portal-identity": token,
        },
      });
      assert.equal(raw.status, 403);
    }
  }
});

test("tenant contexts scope token minting and verification while legacy callers remain compatible", async () => {
  const alpha = createTenantContext({ id: "alpha", env: {}, pooled: true });
  const beta = createTenantContext({ id: "beta", env: {}, pooled: true });
  const claims = { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + 60_000 };
  const token = await runWithTenant(alpha, () => mintCapabilityToken(claims, CAPABILITY));
  assert.equal((await runWithTenant(alpha, () => verifyCapabilityToken(token, CAPABILITY)))?.orgId, "alpha");
  assert.equal(await runWithTenant(beta, () => verifyCapabilityToken(token, CAPABILITY)), null);
  const legacyToken = await mintSignedPayload(claims, CAPABILITY);
  assert.ok(await verifyCapabilityToken(legacyToken, CAPABILITY));
  assert.equal(await runWithTenant(beta, () => verifyCapabilityToken(legacyToken, CAPABILITY)), null);
  const identity = await runWithTenant(alpha, () => mintPortalIdentity({ p: "U1", exp: claims.exp }, PORTAL));
  assert.equal((await runWithTenant(alpha, () => verifyPortalIdentity(identity, PORTAL, Date.now())))?.orgId, "alpha");
  assert.equal(await runWithTenant(beta, () => verifyPortalIdentity(identity, PORTAL, Date.now())), null);
  const source = runWithTenant(alpha, () => coreSignedHeaders(SOURCE, "GET", "/v1/deliveries"));
  assert.equal(source["x-qm-tenant"], "alpha");
  const legacyIdentity = mintPluginIdentity({ p: "U1", exp: claims.exp }, PORTAL);
  assert.ok(verifyPluginIdentity(legacyIdentity, PORTAL, Date.now()));
  assert.equal(verifyPluginIdentity(legacyIdentity, PORTAL, Date.now(), "alpha", true), null);
  const pluginIdentity = mintPluginIdentity({ p: "U1", orgId: "alpha", exp: claims.exp }, PORTAL);
  assert.ok(verifyPluginIdentity(pluginIdentity, PORTAL, Date.now(), "alpha", true));
  assert.equal(verifyPluginIdentity(pluginIdentity, PORTAL, Date.now(), "beta", true), null);
  assert.ok(await verifyPortalIdentity(pluginIdentity, PORTAL, Date.now(), "alpha", true));
  assert.equal(await verifyPortalIdentity(pluginIdentity, PORTAL, Date.now(), "beta", true), null);
});

test("pooled ingress cannot disable authentication or omit its tenant", () => {
  const app = {} as App;
  assert.throws(() => createRequestListener(app, { requireTenantBinding: true, signingSecret: SOURCE }), /tenant ID/);
  assert.throws(
    () => createRequestListener(app, { requireTenantBinding: true, tenantId: "alpha", allowUnauthenticatedCore: true }),
    /authenticated core ingress/,
  );
});
