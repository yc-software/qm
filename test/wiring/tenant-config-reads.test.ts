import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { serverDeps } from "../../src/wiring.ts";
import { registerTenantSettings, tenantFor, withTenant } from "../../src/tenant.ts";
import { deriveTenantSecret } from "../../plugins/chassis/src/tenant-settings.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken, verifyCapabilityToken } from "../../src/auth/capability-token.ts";
import { scopeId } from "../../src/types.ts";

const betaId = randomUUID();
const beta = tenantFor("tenant-beta", betaId, "beta");
registerTenantSettings([
  {
    id: betaId,
    slug: "beta",
    orgId: "tenant-beta",
    hosts: ["beta.example.com"],
    status: "active",
    oidcAdmin: false,
    secrets: {},
  },
]);

const config = testConfig({
  signingSecret: "home-signing-secret-home-signing-secret",
  capabilitySecret: "home-capability-secret-home-capability",
  apiBaseUrl: "https://home.example.com",
  publicWebUrl: "https://home.example.com",
  s3Bucket: "home-bucket",
  s3Region: "us-west-2",
});
const built = buildApp(config);
const deps = serverDeps(config, built);

test("server deps read the current tenant's URLs and secrets at use time", () => {
  assert.equal(deps.apiBaseUrl, "https://home.example.com");
  assert.equal(deps.portalUrl, "https://home.example.com");
  assert.equal(deps.signingSecret, config.signingSecret);
  withTenant(beta, () => {
    assert.equal(deps.apiBaseUrl, "https://beta.example.com");
    assert.equal(deps.portalUrl, "https://beta.example.com");
    assert.equal(deps.signingSecret, deriveTenantSecret(config.signingSecret!, betaId));
    assert.equal(deps.capabilitySecret, deriveTenantSecret(config.capabilitySecret!, betaId));
  });
  assert.equal(deps.apiBaseUrl, "https://home.example.com");
});

test("a registered tenant without its own bucket stores blobs under tenants/<slug>/", () => {
  const blobId = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(built.blobTransfer.s3Ref!(blobId), { bucket: "home-bucket", key: `transfer/${blobId}` });
  assert.deepEqual(
    withTenant(beta, () => built.blobTransfer.s3Ref!(blobId)),
    { bucket: "home-bucket", key: `tenants/beta/transfer/${blobId}` },
  );
});

test("a capability token minted under one tenant does not verify under another", async () => {
  const claims = { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS };
  const forBeta = await withTenant(beta, () => mintCapabilityToken(claims, deps.capabilitySecret!));
  assert.equal(
    (await withTenant(beta, () => verifyCapabilityToken(forBeta, deps.capabilitySecret!)))?.orgId,
    "tenant-beta",
  );
  assert.equal(await verifyCapabilityToken(forBeta, deps.capabilitySecret!), null);
});
