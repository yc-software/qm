import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { orgScope } from "../src/config.ts";
import { withTenant } from "../src/tenants/context.ts";
import { buildApp } from "./support/build-app.ts";
import { OTHER_TENANT, TEST_TENANT } from "./support/tenant.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "deployment-only-secret".repeat(3);
const path = "/v1/tenant-settings";
const SLUG = `t-${TEST_TENANT.slice(-12)}`;

async function fixture(secret: string | undefined = controlSecret) {
  const config = testConfig({ signingSecret: sourceSecret });
  const built = buildApp(config);
  await built.tenantSettings.get();
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    deploymentControlSecret: secret,
    tenantSettings: built.tenantSettings,
    modelCredentials: built.modelCredentials,
    config: built.config,
    featureFlags: built.featureFlags,
    admin: built.admin,
    replayDedupe: built.replayDedupe,
  });
  server.listen(0);
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let nonce = 0;
  const put = async (body: unknown, overrides: Record<string, string> = {}, target = path) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000) + nonce++;
    return fetch(`${origin}${target}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(sourceSecret, ts, `PUT\n${target}\n${raw}`),
        authorization: `Bearer ${controlSecret}`,
        ...overrides,
      },
      body: raw,
    });
  };
  return { built, put, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("tenant settings are written only with both the source signature and the operator control secret", async () => {
  const srv = await fixture();
  try {
    for (const credentials of [{ authorization: "" }, { authorization: `Bearer ${sourceSecret}` }]) {
      assert.equal((await srv.put({ tenant: SLUG, env: { PI_MODEL: "x" } }, credentials)).status, 401);
    }
    assert.equal((await srv.put({ tenant: SLUG, env: { PI_MODEL: "x" } }, { "x-signature": "invalid" })).status, 401);
    const response = await srv.put({ tenant: SLUG, env: { PI_MODEL: "claude-opus-5-5", SPRITES_TOKEN: "token-a" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tenant: TEST_TENANT,
      updated: ["PI_MODEL", "SPRITES_TOKEN"],
    });
    await withTenant(TEST_TENANT, async () => {
      const settings = await srv.built.tenantSettings.get();
      assert.equal(settings.piModel, "claude-opus-5-5");
      assert.equal(settings.values.SPRITES_TOKEN, "token-a");
    });
  } finally {
    await srv.close();
  }
});

test("the settings route refuses operator keys and is unavailable without a distinct control secret", async () => {
  const srv = await fixture();
  try {
    for (const key of [
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "LOOPS_USERS",
      "HARNESS_SECURITY_POSTURE",
      "ORG_BRAND_ACCENT",
    ]) {
      const refused = await srv.put({ tenant: SLUG, env: { [key]: "x", PI_MODEL: "x" } });
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { error: "not_tenant_settings", message: `Not tenant settings: ${key}` });
    }
    await withTenant(TEST_TENANT, async () => assert.notEqual((await srv.built.tenantSettings.get()).piModel, "x"));
    const invalid = await srv.put({ tenant: SLUG, env: { SANDBOX_BACKEND: "nope" } });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { error: string }).error, "invalid_tenant_settings");
    srv.built.tenantSettings.update = async () => {
      throw new Error("settings store unavailable");
    };
    assert.equal((await srv.put({ tenant: SLUG, env: { PI_MODEL: "x" } })).status, 500);
  } finally {
    await srv.close();
  }
  for (const secret of ["", sourceSecret, "short"]) {
    const unavailable = await fixture(secret);
    try {
      assert.equal((await unavailable.put({ tenant: SLUG, env: { PI_MODEL: "x" } })).status, 503);
    } finally {
      await unavailable.close();
    }
  }
});

test("the settings route writes to the tenant its slug names and refuses unknown or invalid slugs", async () => {
  const srv = await fixture();
  try {
    const written = await srv.put({ tenant: SLUG, env: { PI_MODEL: "claude-opus-5-5" } });
    assert.equal(written.status, 200);
    assert.equal(((await written.json()) as { tenant: string }).tenant, TEST_TENANT);
    const other = await srv.put({ tenant: `t-${OTHER_TENANT.slice(-12)}`, env: { SANDBOX_BACKEND: "e2b" } });
    assert.equal(((await other.json()) as { tenant: string }).tenant, OTHER_TENANT);
    await withTenant(OTHER_TENANT, async () =>
      assert.equal((await srv.built.tenantSettings.get()).values.SANDBOX_BACKEND, "e2b"),
    );
    await withTenant(TEST_TENANT, async () =>
      assert.notEqual((await srv.built.tenantSettings.get()).values.SANDBOX_BACKEND, "e2b"),
    );
    await withTenant(OTHER_TENANT, async () => {
      assert.notEqual((await srv.built.tenantSettings.get()).piModel, "claude-opus-5-5");
    });
    for (const body of [{ env: { PI_MODEL: "x" } }, { tenant: "Main", env: { PI_MODEL: "x" } }]) {
      const refused = await srv.put(body);
      assert.equal(refused.status, 400);
      assert.equal(((await refused.json()) as { error: string }).error, "invalid_tenant");
    }
    const unknown = await srv.put({ tenant: "nobody", env: { PI_MODEL: "x" } });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), {
      error: "unknown_tenant",
      message: "No tenant has the slug nobody",
      tenant: "nobody",
    });
  } finally {
    await srv.close();
  }
});

test("the operator sets the admin values the CLI imports, in the named tenant, audited as the operator", async () => {
  const srv = await fixture();
  const scopes = `/v1/admin/scopes/${orgScope()}`;
  try {
    const flag = await srv.put(
      { tenant: SLUG, featureName: "inbox_loops", scopeId: "personal:ada@example.com", on: true },
      {},
      `${scopes}/feature-flags`,
    );
    assert.equal(flag.status, 200);
    await withTenant(TEST_TENANT, async () =>
      assert.equal(await srv.built.featureFlags.enabled("inbox_loops", "personal:ada@example.com"), true),
    );
    await withTenant(OTHER_TENANT, async () =>
      assert.equal(await srv.built.featureFlags.enabled("inbox_loops", "personal:ada@example.com"), false),
    );
    await withTenant(TEST_TENANT, async () =>
      assert.equal(
        (await srv.built.featureFlags.list()).find((row) => row.featureName === "inbox_loops")?.updatedBy,
        "operator",
      ),
    );
    const first = await srv.put({ tenant: SLUG, posture: "strict", ifUnset: true }, {}, `${scopes}/security-posture`);
    assert.deepEqual(await first.json(), { ok: true, scopeId: orgScope(), resource: "security-posture" });
    const again = await srv.put({ tenant: SLUG, posture: "auto", ifUnset: true }, {}, `${scopes}/security-posture`);
    assert.equal(((await again.json()) as { unchanged?: boolean }).unchanged, true);
    await withTenant(TEST_TENANT, async () =>
      assert.equal(await srv.built.config.getSecurityPostureOwnDurable(orgScope()), "strict"),
    );

    await withTenant(TEST_TENANT, () => srv.built.modelCredentials.set("anthropic", "stored-key", "admin@example.com"));
    const key = await srv.put(
      { tenant: SLUG, apiKey: "pushed-key", ifUnset: true },
      {},
      "/v1/admin/model-providers/anthropic",
    );
    assert.equal(((await key.json()) as { unchanged?: boolean }).unchanged, true);
    await withTenant(TEST_TENANT, async () =>
      assert.equal(await srv.built.modelCredentials.resolve("anthropic"), "stored-key"),
    );
    const soul = await srv.put({ tenant: SLUG, text: "x" }, {}, `${scopes}/soul`);
    assert.equal(soul.status, 403);
    const noTenant = await srv.put({ posture: "strict" }, {}, `${scopes}/security-posture`);
    assert.equal(((await noTenant.json()) as { error: string }).error, "invalid_tenant");
    const wrongBearer = await srv.put(
      { tenant: SLUG, posture: "strict" },
      { authorization: `Bearer ${sourceSecret}` },
      `${scopes}/security-posture`,
    );
    assert.equal(wrongBearer.status, 401);
    const flagIfUnset = await srv.put(
      { tenant: SLUG, featureName: "inbox_loops", scopeId: "personal:bo@example.com", on: true, ifUnset: true },
      {},
      `${scopes}/feature-flags`,
    );
    assert.equal(flagIfUnset.status, 400);
  } finally {
    await srv.close();
  }
});
