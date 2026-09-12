import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

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

function startAnthropic(): {
  base: string;
  built: ReturnType<typeof buildApp>;
  close: () => Promise<void>;
} {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "model-classification-vis-")),
      anthropicApiKey: "deployment-anthropic-key",
    }),
    { modelCredentialFetch: async () => new Response(null, { status: 200 }) },
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    modelCredentialFetch: async () => new Response(null, { status: 200 }),
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const classify = (base: string, modelId: string, status: string) =>
  fetch(`${base}/v1/admin/scopes/org%3Adefault-org/model-classifications`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify({ modelId, status }),
  });

test("a hidden model drops from the surface picker and base options; a legacy one stays", async () => {
  const srv = startAnthropic();
  try {
    assert.equal((await classify(srv.base, "claude-sonnet-5", "hidden")).status, 200);
    assert.equal((await classify(srv.base, "claude-haiku-4-5", "legacy")).status, 200);

    const surface = await fetch(`${srv.base}/v1/surface-config`);
    const surfaceModels = ((await surface.json()) as { webuiModels: string[] }).webuiModels;
    assert.ok(!surfaceModels.includes("claude-sonnet-5"));
    assert.ok(surfaceModels.includes("claude-opus-5"));
    assert.ok(surfaceModels.includes("claude-haiku-4-5"));

    const scope = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    const data = (await scope.json()) as {
      baseModelOptions: Array<{ id: string }>;
      modelsByHarness: Record<string, Array<{ id: string }>>;
      browseModelOptions: Array<{ id: string }>;
    };
    const has = (list: Array<{ id: string }>, id: string) => list.some((m) => m.id === id);
    assert.ok(!has(data.baseModelOptions, "claude-sonnet-5"));
    assert.ok(has(data.baseModelOptions, "claude-opus-5"));
    assert.ok(has(data.baseModelOptions, "claude-haiku-4-5"));
    assert.ok(!has(data.modelsByHarness.pi!, "claude-sonnet-5"));
    assert.ok(!has(data.browseModelOptions, "claude-sonnet-5"));
  } finally {
    await srv.close();
  }
});

test("a hidden model pinned as the base survives for the scope that runs it, not for others", async () => {
  const srv = startAnthropic();
  try {
    assert.equal((await classify(srv.base, "claude-opus-4-8", "hidden")).status, 200);
    const pinned = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-4-8" }),
    });
    assert.equal(pinned.status, 200);

    const orgScope = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    const orgOptions = ((await orgScope.json()) as { baseModelOptions: Array<{ id: string }> }).baseModelOptions;
    assert.ok(
      orgOptions.some((m) => m.id === "claude-opus-4-8"),
      "the org that pinned it still sees it",
    );

    const personalScope = await fetch(`${srv.base}/v1/admin/scopes/personal%3Aalice`, { headers: ADMIN });
    const personalOptions = ((await personalScope.json()) as { baseModelOptions: Array<{ id: string }> })
      .baseModelOptions;
    assert.ok(!personalOptions.some((m) => m.id === "claude-opus-4-8"), "a scope that didn't pin it loses it");
  } finally {
    await srv.close();
  }
});

test("a child scope's config reports the org classification map that filters its own options", async () => {
  const srv = startAnthropic();
  try {
    assert.equal((await classify(srv.base, "claude-sonnet-5", "hidden")).status, 200);
    const personalScope = await fetch(`${srv.base}/v1/admin/scopes/personal%3Aalice`, { headers: ADMIN });
    const data = (await personalScope.json()) as {
      modelClassifications: Record<string, string>;
      modelsByHarness: Record<string, Array<{ id: string }>>;
    };
    assert.equal(data.modelClassifications["claude-sonnet-5"], "hidden");
    assert.ok(!data.modelsByHarness.pi!.some((m) => m.id === "claude-sonnet-5"));
  } finally {
    await srv.close();
  }
});

test("the config reports the unfiltered default picker set, so a non-serviceable default is not lost when the picker is materialized", async () => {
  const srv = startAnthropic();
  try {
    const org = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    const data = (await org.json()) as {
      webuiModelDefaults: string[];
      modelsByHarness: Record<string, Array<{ id: string }>>;
    };
    assert.ok(
      data.webuiModelDefaults.includes("gpt-5.6-sol"),
      "the default set is provider-key-independent, so an OpenAI model stays in it under an Anthropic-only deployment",
    );
    assert.ok(
      !data.modelsByHarness.codex!.some((m) => m.id === "gpt-5.6-sol"),
      "the filtered options do omit it, which is exactly why materializing from them would drop it",
    );
  } finally {
    await srv.close();
  }
});

test("the classification route validates the model id, the status, the scope, and the actor", async () => {
  const srv = startAnthropic();
  try {
    const unknown = await classify(srv.base, "no-such-model", "hidden");
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { message: string }).message, /unknown model id/);

    const badStatus = await classify(srv.base, "claude-opus-5", "retired");
    assert.equal(badStatus.status, 400);
    assert.match(((await badStatus.json()) as { message: string }).message, /status must be one of/);

    const wrongScope = await fetch(`${srv.base}/v1/admin/scopes/personal%3Aalice/model-classifications`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-5", status: "hidden" }),
    });
    assert.equal(wrongScope.status, 400);
    assert.match(((await wrongScope.json()) as { message: string }).message, /org-wide/);

    const nonAdmin = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org/model-classifications`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ modelId: "claude-opus-5", status: "hidden" }),
    });
    assert.equal(nonAdmin.status, 403);
  } finally {
    await srv.close();
  }
});
