import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, testTenantSettings } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { bindTestTenant } from "./support/tenant.ts";
import { TEST_TENANT } from "./support/tenant.ts";

bindTestTenant();

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice" };

afterEach(() => setCustomProviders([]));

test("serverDeps wires the custom-provider store and resolves a custom boot default lazily", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "custom-provider-boot-")),
  });
  const built = buildApp(config, {
    tenantSettings: testTenantSettings({ PI_MODEL: "custom/acme-gateway/acme-large" }),
    modelCredentialFetch: async () => new Response(null, { status: 200 }),
  });
  await built.tenantSettings.get();
  const deps = serverDeps(config, built);
  assert.equal(deps.customProviders, built.customProviders);
  assert.equal(deps.refreshCustomProviders, built.refreshCustomProviders);

  const server = createInsecureTestServer(TEST_TENANT, built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    assert.notEqual(deps.baseModelDefault?.(), "custom/acme-gateway/acme-large");

    const list = await fetch(`${base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);

    const put = await fetch(`${base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Acme Gateway",
        protocol: "openai",
        baseUrl: "https://llm.acme.internal/v1",
        models: [{ id: "acme-large", name: "Acme Large" }],
        apiKey: "sk-acme-secret",
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    assert.equal(deps.baseModelDefault?.(), "custom/acme-gateway/acme-large");

    const runtime = await fetch(`${base}/v1/runtime-config?principalId=admin-alice&scopeId=personal:admin-alice`, {
      headers: ADMIN,
    });
    assert.equal(runtime.status, 200);
    const body = (await runtime.json()) as {
      effective: { modelId: string };
      models: string[];
      modelCatalog: Record<string, { name: string; provider: string }>;
    };
    assert.equal(body.effective.modelId, "custom/acme-gateway/acme-large");
    assert.ok(body.models.includes("custom/acme-gateway/acme-large"));
    assert.equal(body.modelCatalog["custom/acme-gateway/acme-large"]?.provider, "acme-gateway");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
