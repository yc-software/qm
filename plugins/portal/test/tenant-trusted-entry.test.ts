import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTenantSignIn } from "../../chassis/src/tenant-sign-in.ts";
import { createTrustedEntry, tenantTrustedConfig } from "../src/trusted-entry.ts";

const bridge = {
  issuer: "https://bridge.example",
  authEndpoint: "https://bridge.example/authorize",
  tokenEndpoint: "https://bridge.example/token",
  userinfoEndpoint: "https://bridge.example/userinfo",
  jwksUri: "https://bridge.example/jwks",
};

const tenant = (slug: string) =>
  parseTenantSignIn({
    trustedOidc: JSON.stringify({ ...bridge, clientId: slug }),
    trustedClientSecret: `${slug}-trusted-client-secret-of-32-chars`,
    publicUrl: `https://${slug}.example/`,
  });

const env = { NODE_ENV: "production" };
const deploymentUrl = "https://shared.example";

test("each tenant host signs in through its own trusted client and redirect", () => {
  for (const slug of ["company-a", "company-b"]) {
    const cfg = tenantTrustedConfig(env, deploymentUrl, tenant(slug))!;
    assert.equal(cfg.clientId, slug);
    assert.equal(cfg.clientSecret, `${slug}-trusted-client-secret-of-32-chars`);
    assert.equal(cfg.redirectUri, `https://${slug}.example/auth/trusted/callback`);
    const location = new URL(createTrustedEntry(cfg, "s".repeat(40), async () => true).start("/").location);
    assert.equal(location.searchParams.get("client_id"), slug);
    assert.equal(location.searchParams.get("redirect_uri"), `https://${slug}.example/auth/trusted/callback`);
  }
});

test("a tenant without trusted settings keeps the deployment client, and none means no trusted entry", () => {
  assert.equal(tenantTrustedConfig(env, deploymentUrl, {}), null);
  const deployment = {
    ...env,
    PORTAL_TRUSTED_OIDC: JSON.stringify({ ...bridge, clientId: "deployment" }),
    PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "deployment-trusted-client-secret-32",
  };
  const cfg = tenantTrustedConfig(deployment, deploymentUrl, {})!;
  assert.deepEqual([cfg.clientId, cfg.redirectUri], ["deployment", "https://shared.example/auth/trusted/callback"]);
});
