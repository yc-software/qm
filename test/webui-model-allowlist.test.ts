import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("deployment model policy exposes org plus only the active scope", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scope-model-policy-"));
  const policyPath = join(dataDir, "models.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      scopes: {
        "org:default-org": { models: ["claude-sonnet-5"], default: "claude-sonnet-5" },
        "personal:alice": { models: ["claude-opus-5"], default: "claude-opus-5" },
        "group:web-project-one": { models: ["gpt-5.6-luna"], default: "gpt-5.6-luna" },
        "team:engineering": { models: ["claude-haiku-4-5"] },
      },
    }),
  );
  const built = buildApp(testConfig({ dataDir, modelScopeAllowlistsPath: policyPath }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelScopePolicy: built.modelScopePolicy,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: true, openrouter: true },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const runtime = async (scopeId: string): Promise<{ models: string[]; defaultModel: string }> => {
    const response = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=${encodeURIComponent(scopeId)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      modelsByHarness: Record<string, string[]>;
      effective: { modelId: string };
    };
    return { models: body.modelsByHarness.pi!, defaultModel: body.effective.modelId };
  };
  try {
    assert.deepEqual(await runtime("personal:alice"), {
      models: ["claude-sonnet-5", "claude-opus-5"],
      defaultModel: "claude-opus-5",
    });
    const update = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", inherit: true }),
    });
    assert.equal(update.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the org allowed-models list restricts the runtime-config picker and clearing restores the catalog", async () => {
  const modelCredentialFetch: typeof fetch = async () =>
    Response.json({
      data: [
        { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", supported_parameters: ["tools"] },
        { id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek: DeepSeek V3.1", supported_parameters: ["tools"] },
      ],
    });
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "webui-model-allowlist-")),
      openrouterApiKey: "deployment-openrouter-key",
    }),
    { modelCredentialFetch },
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    modelCredentialFetch,
    harnessId: "pi",
    providerKeys: { anthropic: false, openai: false, openrouter: true },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const runtimeModels = async (): Promise<string[]> => {
    const response = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(response.status, 200);
    return ((await response.json()) as { modelsByHarness: Record<string, string[]> }).modelsByHarness.pi!;
  };
  try {
    const unrestricted = await runtimeModels();
    assert.ok(unrestricted.includes("anthropic/claude-sonnet-4.5"));
    assert.ok(unrestricted.includes("deepseek/deepseek-chat-v3.1"));

    const saved = await fetch(`${base}/v1/admin/scopes/org%3Adefault-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: ["deepseek/deepseek-chat-v3.1", "openrouter/auto"] }),
    });
    assert.equal(saved.status, 200);

    assert.deepEqual(await runtimeModels(), ["deepseek/deepseek-chat-v3.1", "openrouter/auto"]);

    const cleared = await fetch(`${base}/v1/admin/scopes/org%3Adefault-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(cleared.status, 200);
    const restored = await runtimeModels();
    assert.ok(restored.includes("anthropic/claude-sonnet-4.5"));
    assert.ok(restored.includes("deepseek/deepseek-chat-v3.1"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
