import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { withTenant } from "../src/tenants/context.ts";
import { buildApp, TEST_TENANT } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "deployment-only-secret".repeat(3);
const path = "/v1/tenant-settings";

async function fixture(secret: string | undefined = controlSecret) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    deploymentControlSecret: secret,
    tenantSettings: built.tenantSettings,
    modelCredentials: built.modelCredentials,
    config: built.config,
  });
  server.listen(0);
  const url = `http://localhost:${(server.address() as AddressInfo).port}${path}`;
  let nonce = 0;
  const put = async (body: unknown, overrides: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000) + nonce++;
    return fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(sourceSecret, ts, `PUT\n${path}\n${raw}`),
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
      assert.equal((await srv.put({ env: { PI_MODEL: "x" } }, credentials)).status, 401);
    }
    assert.equal((await srv.put({ env: { PI_MODEL: "x" } }, { "x-signature": "invalid" })).status, 401);
    const response = await srv.put({ env: { PI_MODEL: "claude-opus-5-5", ANTHROPIC_API_KEY: "key-a" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tenant: TEST_TENANT,
      updated: ["PI_MODEL", "ANTHROPIC_API_KEY"],
    });
    await withTenant(TEST_TENANT, async () => {
      assert.equal((await srv.built.tenantSettings.get()).piModel, "claude-opus-5-5");
      assert.equal(await srv.built.modelCredentials.resolve("anthropic"), "key-a");
    });
  } finally {
    await srv.close();
  }
});

test("the settings route refuses operator keys and is unavailable without a distinct control secret", async () => {
  const srv = await fixture();
  try {
    const refused = await srv.put({ env: { DATABASE_URL: "postgres://x", PI_MODEL: "x" } });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), {
      error: "not_tenant_settings",
      message: "Not tenant settings: DATABASE_URL",
    });
    assert.equal((await srv.put({ env: { SANDBOX_BACKEND: "nope" } })).status, 400);
  } finally {
    await srv.close();
  }
  for (const secret of ["", sourceSecret, "short"]) {
    const unavailable = await fixture(secret);
    try {
      assert.equal((await unavailable.put({ env: { PI_MODEL: "x" } })).status, 503);
    } finally {
      await unavailable.close();
    }
  }
});
