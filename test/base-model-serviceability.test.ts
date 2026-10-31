import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { ModelProvider } from "../src/model/model-credential-store.ts";
import { modelProviderAvailabilityFor } from "../src/model/pi-models.ts";
import { defaultModelFor } from "../src/model/tenant-models.ts";
import type { TenantSettingValues } from "../src/tenants/settings.ts";
import { buildApp, testTenantSettings } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { TEST_ROOT_SCOPE, bindTestTenant } from "./support/tenant.ts";

bindTestTenant();

bindTestTenant();

bindTestTenant();

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice" };

async function start(
  keys: Partial<Record<ModelProvider, string>> = { anthropic: "deployment-anthropic-key" },
  settings: TenantSettingValues = {},
) {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "base-model-svc-")), harness: "pi" });
  const built = buildApp(config, { tenantSettings: testTenantSettings(settings) });
  for (const [provider, key] of Object.entries(keys))
    await built.modelCredentials.set(provider as ModelProvider, key, "test");
  await built.tenantSettings.get();
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    acl: built.acl,
    modelCredentials: built.modelCredentials,
    tenantSettings: built.tenantSettings,
    harnessId: "pi",
    baseModelDefault: () => defaultModelFor(built.tenantSettings.peek(), "pi"),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function effectiveModel(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { effective: { modelId: string } }).effective.modelId;
}

test("base-model set rejects a model whose provider key is absent (would fail provider-side)", async () => {
  const srv = await start();
  try {
    const bad = await fetch(`${srv.base}/v1/admin/scopes/${TEST_ROOT_SCOPE}/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "gpt-5.6-sol" }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message?: string }).message ?? "", /serviceable|provider key/i);

    const ok = await fetch(`${srv.base}/v1/admin/scopes/${TEST_ROOT_SCOPE}/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-4-8" }),
    });
    assert.equal(ok.status, 200, "an Anthropic model stays selectable when the Anthropic key is present");
  } finally {
    await srv.close();
  }
});

test("ChatGPT OAuth stays separate from OpenAI API-key availability on Pi", async () => {
  const built = buildApp(testConfig({ harness: "pi" }), {
    tenantSettings: testTenantSettings({ CODEX_AUTH_CREDENTIAL: "company-chatgpt" }),
  });
  const configured = await built.modelCredentials.availability();
  assert.equal(configured.openai, false);
  assert.equal(configured.codexOAuth, true);
  assert.equal(modelProviderAvailabilityFor("pi", configured).openai, false);
});

test("a deployment that declares a provider runs that provider's base model", async () => {
  for (const [modelProvider, expected] of [
    ["anthropic", "claude-opus-5"],
    ["openai", "gpt-6.1-sol"],
    ["openrouter", "openrouter/auto"],
  ] as const) {
    const srv = await start({ [modelProvider]: `deployment-${modelProvider}-key` }, { MODEL_PROVIDER: modelProvider });
    try {
      assert.equal(
        await effectiveModel(srv.base),
        expected,
        `modelProvider "${modelProvider}" must land on a model that provider can bill`,
      );
    } finally {
      await srv.close();
    }
  }
});

test("an undeclared deployment keeps the shipped default, whatever keys it holds", async () => {
  for (const keys of [{}, { openrouter: "k" }, { openai: "k" }] as const) {
    const srv = await start(keys);
    try {
      assert.equal(
        await effectiveModel(srv.base),
        "claude-opus-5",
        "upgrading must not move an existing deployment's model or its billing",
      );
    } finally {
      await srv.close();
    }
  }
});

test("the declaration outranks a stray key from another vendor", async () => {
  const srv = await start(
    { openrouter: "deployment-openrouter-key", anthropic: "stray-anthropic-key" },
    { MODEL_PROVIDER: "openrouter" },
  );
  try {
    assert.equal(await effectiveModel(srv.base), "openrouter/auto");
  } finally {
    await srv.close();
  }
});

test("company ChatGPT-only deployments offer their plain GPT default through managed availability", async () => {
  const srv = await start({}, { CODEX_AUTH_CREDENTIAL: "company-chatgpt" });
  try {
    const res = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      effective: { modelId: string };
      modelsByHarness: Record<string, string[]>;
      unavailableReason?: string;
    };
    assert.equal(body.effective.modelId, "gpt-6.1-sol");
    assert.ok(body.modelsByHarness.pi?.includes("gpt-6.1-sol"));
    assert.equal(body.unavailableReason, undefined);
  } finally {
    await srv.close();
  }
});
