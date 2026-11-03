import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { canonicalPayload, TENANT_HEADER } from "../plugins/chassis/src/source-auth-sign.ts";
import { orgScope } from "../src/config.ts";
import { withTenant } from "../src/tenants/context.ts";
import { applyTenantImport, tenantImport, type OperatorCall } from "../cli/src/tenant-import.ts";
import { buildApp } from "./support/build-app.ts";
import { testTenants } from "./support/test-tenants.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "deployment-only-secret".repeat(3);
const [TEST_TENANT] = testTenants();

test("the CLI import lands in the named tenant through core's operator routes and keeps admin edits", async () => {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  await built.tenantSettings.get();
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    deploymentControlSecret: controlSecret,
    tenantSettings: built.tenantSettings,
    modelCredentials: built.modelCredentials,
    modelCredentialFetch: async () => new Response("{}", { status: 200 }),
    config: built.config,
    featureFlags: built.featureFlags,
    admin: built.admin,
    replayDedupe: built.replayDedupe,
    createTenant: async (tenant) => ({ tenant, created: false }),
  });
  server.listen(0);
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call: OperatorCall = async (path, body, tenant) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const response = await fetch(`${origin}${path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(sourceSecret, ts, canonicalPayload("PUT", path, raw, tenant)),
        authorization: `Bearer ${controlSecret}`,
        ...(tenant ? { [TENANT_HEADER]: tenant } : {}),
      },
      body: raw,
    });
    return { status: response.status, body: await response.text() };
  };
  const env = {
    PI_MODEL: "claude-opus-5-5",
    ANTHROPIC_API_KEY: "sk-ant-pushed",
    ORG_BRAND_ORG_NAME: "Acme",
    HARNESS_SECURITY_POSTURE: "strict",
    GOOGLE_OAUTH_CLIENT_ID: "gid",
    GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
    LOOPS_USERS: "Ada@Example.com",
  };
  try {
    const warnings: string[] = [];
    const { applied: first } = await applyTenantImport(tenantImport(env), TEST_TENANT, call, (message) =>
      warnings.push(message),
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(first, [
      "PI_MODEL",
      "branding",
      "security-posture",
      "google OAuth client",
      "inbox_loops for personal:ada@example.com",
      "anthropic API key",
    ]);
    await withTenant(TEST_TENANT, async () => {
      assert.equal((await built.tenantSettings.get()).piModel, "claude-opus-5-5");
      assert.equal((await built.config.getBrandingDurable(orgScope()))?.orgName, "Acme");
      assert.equal(await built.config.getSecurityPostureOwnDurable(orgScope()), "strict");
      assert.equal((await built.config.getConnectorClientSecret(orgScope(), "google"))?.clientId, "gid");
      const aliased = await call(
        "/v1/admin/scopes/tenant/security-posture?nonce=alias",
        { posture: "strict" },
        TEST_TENANT,
      );
      assert.equal(aliased.status, 200, aliased.body);
      assert.equal(
        JSON.parse(aliased.body).scopeId,
        orgScope(),
        "the tenant alias resolves to the tenant's root scope",
      );
      assert.equal(await built.featureFlags.enabled("inbox_loops", "personal:ada@example.com"), true);
      assert.equal(await built.modelCredentials.resolve("anthropic"), "sk-ant-pushed");
      await built.config.setSecurityPosture(orgScope(), "auto");
      await built.modelCredentials.set("anthropic", "sk-ant-admin", "admin@example.com");
    });
    const { applied: again } = await applyTenantImport(
      tenantImport({ ...env, HARNESS_SECURITY_POSTURE: "dangerous", ANTHROPIC_API_KEY: "sk-ant-other" }),
      TEST_TENANT,
      call,
      () => {},
    );
    assert.deepEqual(again, ["PI_MODEL", "inbox_loops for personal:ada@example.com"]);
    const repeated = tenantImport({ ...env, HARNESS_SECURITY_POSTURE: "dangerous", ANTHROPIC_API_KEY: "sk-ant-other" });
    const { applied: immediate } = await applyTenantImport(repeated, TEST_TENANT, call, () => {});
    assert.deepEqual(immediate, again, "an identical import right after the last one is not refused as a replay");
    await withTenant(TEST_TENANT, async () => {
      assert.equal(await built.config.getSecurityPostureOwnDurable(orgScope()), "auto");
      assert.equal(await built.modelCredentials.resolve("anthropic"), "sk-ant-admin");
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
