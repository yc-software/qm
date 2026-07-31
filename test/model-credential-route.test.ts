import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createModelCredentialStore, type StoredModelCredential } from "../src/model/model-credential-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(
  config: Parameters<typeof testConfig>[0] = {},
  modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 }),
): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "model-credential-route-")),
      ...config,
    }),
    { modelCredentialFetch },
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    modelCredentialFetch,
    harnessId: config.harness ?? "pi",
    providerKeys: {
      anthropic: Boolean(config.anthropicApiKey),
      openai: Boolean(config.openaiApiKey),
      openrouter: Boolean(config.openrouterApiKey),
    },
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

test("admin model credentials are encrypted, write-only, live, and removable", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    const initial = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      providers: [
        { provider: "anthropic", configured: true, source: "environment" },
        { provider: "openai", configured: false, source: "absent" },
        { provider: "openrouter", configured: false, source: "absent" },
      ],
      models: [
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
        { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
      ],
    });
    const scopeBefore = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(scopeBefore.status, 200);
    const beforeOptions = ((await scopeBefore.json()) as { baseModelOptions: Array<{ id: string }> }).baseModelOptions;
    assert.ok(!beforeOptions.some((model) => model.id === "gpt-5.6-sol"));

    const denied = await fetch(`${srv.base}/v1/admin/model-providers/openai`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ apiKey: "denied-openai-key" }),
    });
    assert.equal(denied.status, 403);

    const saved = await fetch(`${srv.base}/v1/admin/model-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ apiKey: "admin-openai-key" }),
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /admin-openai-key/);
    assert.equal(await srv.built.modelCredentials.resolve("openai"), "admin-openai-key");
    const scopeAfter = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(scopeAfter.status, 200);
    const afterOptions = ((await scopeAfter.json()) as { baseModelOptions: Array<{ id: string }> }).baseModelOptions;
    assert.ok(afterOptions.some((model) => model.id === "gpt-5.6-sol"));

    const status = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /deployment-anthropic-key|admin-openai-key/);
    assert.match(statusText, /"source":"admin"/);

    const removed = await fetch(`${srv.base}/v1/admin/model-providers/openai`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(removed.status, 200);
    assert.equal(await srv.built.modelCredentials.resolve("openai"), null);
    assert.equal(await srv.built.modelCredentials.resolve("anthropic"), "deployment-anthropic-key");
  } finally {
    await srv.close();
  }
});

test("OpenRouter validation uses an authenticated endpoint", async () => {
  let requested = "";
  const srv = start({}, async (input) => {
    requested = String(input);
    return new Response(null, { status: 401 });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/openrouter`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ apiKey: "not-a-real-key" }),
    });
    assert.equal(response.status, 400);
    assert.equal(requested, "https://openrouter.ai/api/v1/key");
    assert.equal(await srv.built.modelCredentials.resolve("openrouter"), null);
  } finally {
    await srv.close();
  }
});

test("OpenRouter catalog exposes runtime-supported tool models as selectable base models", async () => {
  let requested = "";
  let catalogRequests = 0;
  const srv = start({ openrouterApiKey: "deployment-openrouter-key" }, async (input) => {
    requested = String(input);
    catalogRequests++;
    return Response.json({
      data: [
        {
          id: "anthropic/claude-sonnet-4.5",
          name: "Anthropic: Claude Sonnet 4.5",
          supported_parameters: ["tools"],
        },
        {
          id: "vendor/not-in-the-pinned-runtime",
          name: "Future Model",
          supported_parameters: ["tools"],
        },
        {
          id: "openai/gpt-4o",
          name: "No Tools",
          supported_parameters: ["temperature"],
        },
      ],
    });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const models = (
      (await response.json()) as {
        models: Array<{ id: string; name: string; provider: string }>;
      }
    ).models.filter((model) => model.provider === "openrouter");
    assert.deepEqual(models, [
      { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
      { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", provider: "openrouter" },
    ]);
    assert.equal(requested, "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular");

    const selected = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "anthropic/claude-sonnet-4.5" }),
    });
    assert.equal(selected.status, 200);
    assert.equal(srv.built.config.getBaseModel("org:default-org"), "anthropic/claude-sonnet-4.5");

    const governance = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(governance.status, 200);
    const governanceBody = (await governance.json()) as {
      baseModelOptions: Array<{ id: string; name: string }>;
      modelsByHarness: Record<string, Array<{ id: string; name: string }>>;
      runtime: { harnessId: string; modelId: string };
    };
    assert.ok(governanceBody.baseModelOptions.some((model) => model.id === "anthropic/claude-sonnet-4.5"));
    assert.ok(governanceBody.modelsByHarness.pi!.some((model) => model.id === "anthropic/claude-sonnet-4.5"));
    assert.equal(governanceBody.runtime.modelId, "anthropic/claude-sonnet-4.5");

    const runtime = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(runtime.status, 200);
    const runtimeBody = (await runtime.json()) as {
      modelsByHarness: Record<string, string[]>;
      modelCatalog: Record<string, { name: string; provider: string }>;
      effective: { harnessId: string; modelId: string };
    };
    assert.ok(runtimeBody.modelsByHarness.pi!.includes("anthropic/claude-sonnet-4.5"));
    assert.deepEqual(runtimeBody.modelCatalog["anthropic/claude-sonnet-4.5"], {
      name: "Anthropic: Claude Sonnet 4.5",
      provider: "openrouter",
    });
    assert.deepEqual(runtimeBody.effective, { harnessId: "pi", modelId: "anthropic/claude-sonnet-4.5" });

    const surface = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(surface.status, 200);
    const surfaceBody = (await surface.json()) as { webuiModels: string[]; baseModel: string };
    assert.ok(surfaceBody.webuiModels.includes("anthropic/claude-sonnet-4.5"));
    assert.equal(surfaceBody.baseModel, "anthropic/claude-sonnet-4.5");

    const turn = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "web:alice:openrouter-catalog" },
      text: "hello",
      model: "anthropic/claude-sonnet-4.5",
      async: true,
    });
    assert.equal(turn.status, "queued");
    assert.equal(catalogRequests, 1);
  } finally {
    await srv.close();
  }
});

test("web turns keep a persisted OpenRouter model enabled when the refreshed catalog omits it", async () => {
  const srv = start({ openrouterApiKey: "deployment-openrouter-key" }, async () =>
    Response.json({
      data: [
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Anthropic: Claude Haiku 4.5",
          supported_parameters: ["tools"],
        },
      ],
    }),
  );
  try {
    srv.built.config.setBaseModel("org:default-org", "anthropic/claude-sonnet-4.5");
    const turn = (threadRef: string, model: string) =>
      srv.built.app.turn({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef },
        text: "hello",
        model,
        async: true,
      });

    const persisted = await turn("web:alice:persisted-openrouter-model", "anthropic/claude-sonnet-4.5");
    assert.equal(persisted.status, "queued");

    await srv.built.config.setRuntimeSelectionLatest("personal:alice", {
      harnessId: "mock",
      modelId: "openai/gpt-oss-20b:free",
    });
    const arbitrary = await turn("web:alice:arbitrary-openrouter-model", "openai/gpt-oss-20b:free");
    assert.equal(arbitrary.status, "refused");
    assert.match(arbitrary.reason ?? "", /not enabled for the web UI/);
  } finally {
    await srv.close();
  }
});

test("an oversized OpenRouter catalog falls back to the built-in models", async () => {
  const srv = start({ openrouterApiKey: "deployment-openrouter-key" }, async () =>
    Response.json({
      data: [
        {
          id: "anthropic/claude-sonnet-4.5",
          name: `Anthropic: Claude Sonnet 4.5${"x".repeat(2_100_000)}`,
          supported_parameters: ["tools"],
        },
      ],
    }),
  );
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const models = (
      (await response.json()) as {
        models: Array<{ id: string; provider: string }>;
      }
    ).models;
    assert.ok(!models.some((model) => model.id === "anthropic/claude-sonnet-4.5"));
    assert.ok(models.some((model) => model.id === "openrouter/auto"));
  } finally {
    await srv.close();
  }
});

test("managed Pi keys do not advertise unsupported OpenCode or browser credentials", async () => {
  const srv = start({ harness: "opencode" });
  try {
    for (const provider of ["anthropic", "openai"] as const) {
      const response = await fetch(`${srv.base}/v1/admin/model-providers/${provider}`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ apiKey: `managed-${provider}-key` }),
      });
      assert.equal(response.status, 200);
    }
    const response = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      baseModelOptions: Array<{ id: string }>;
      browseModelOptions: Array<{ id: string }>;
      modelsByHarness: Record<string, Array<{ id: string }>>;
    };
    assert.deepEqual(data.baseModelOptions, []);
    assert.deepEqual(data.browseModelOptions, []);
    assert.ok(data.modelsByHarness.pi!.some((model) => model.id === "gpt-5.6-sol"));
    assert.ok(!data.modelsByHarness.opencode!.some((model) => model.id === "gpt-5.6-sol"));
  } finally {
    await srv.close();
  }
});

test("web turns gate the requested and scope-selected harness against its real key source", async () => {
  const srv = start({ harness: "pi" });
  try {
    await srv.built.modelCredentials.set("openai", "managed-openai-key", "admin-alice");
    srv.built.config.setApprovedHarnesses(["pi", "opencode"]);
    const turn = (threadRef: string, overrides: { harness?: string; model?: string } = {}) =>
      srv.built.app.turn({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef },
        text: "hello",
        async: true,
        ...overrides,
      });

    const requested = await turn("web:alice:requested-opencode", { harness: "opencode", model: "gpt-5.6-sol" });
    assert.equal(requested.status, "refused");
    assert.match(requested.reason ?? "", /provider isn't configured/);

    await srv.built.config.setRuntimeSelectionLatest("personal:alice", {
      harnessId: "opencode",
      modelId: "gpt-5.6-sol",
    });
    const configured = await turn("web:alice:configured-opencode");
    assert.equal(configured.status, "refused");
    assert.match(configured.reason ?? "", /provider isn't configured/);
  } finally {
    await srv.close();
  }
});

test("a rejected rotation preserves the prior key and disabling suppresses environment fallback", async () => {
  let accepts = true;
  const srv = start(
    { anthropicApiKey: "deployment-anthropic-key" },
    async () => new Response(null, { status: accepts ? 200 : 401 }),
  );
  try {
    const save = (apiKey: string) =>
      fetch(`${srv.base}/v1/admin/model-providers/anthropic`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ apiKey }),
      });
    assert.equal((await save("working-admin-key")).status, 200);
    accepts = false;
    assert.equal((await save("rejected-admin-key")).status, 400);
    assert.equal(await srv.built.modelCredentials.resolve("anthropic"), "working-admin-key");

    const disabled = await fetch(`${srv.base}/v1/admin/model-providers/anthropic`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(disabled.status, 200);
    assert.equal(await srv.built.modelCredentials.resolve("anthropic"), null);
    const status = (await srv.built.modelCredentials.statuses()).find((item) => item.provider === "anthropic")!;
    assert.equal(status.configured, false);
    assert.equal(status.source, "admin");
    assert.equal(status.updatedBy, "admin-alice");
  } finally {
    await srv.close();
  }
});

test("surface-config reports whether any model provider is configured", async () => {
  const srv = start();
  try {
    const before = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, false);

    await srv.built.modelCredentials.set("anthropic", "working-admin-key", "admin-alice@default-org");
    const after = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(((await after.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, true);
  } finally {
    await srv.close();
  }
});

test("admin model credentials survive a second app instance on the same durable store", async () => {
  const backing = createMemoryMap<StoredModelCredential>();
  const first = createModelCredentialStore({ backing, keyMaterial: "shared-model-key" });
  await first.set("openrouter", "durable-openrouter-key", "admin-alice@default-org");

  const second = createModelCredentialStore({ backing, keyMaterial: "shared-model-key" });
  assert.equal(await second.resolve("openrouter"), "durable-openrouter-key");
  assert.doesNotMatch(JSON.stringify(await backing.all()), /durable-openrouter-key/);
  assert.doesNotMatch(JSON.stringify(await second.statuses()), /durable-openrouter-key/);
});

test("a stored scope override outside the configured picker refuses web turns; the org default stays exempt", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    srv.built.config.setRuntimeSelection("org:default-org", { harnessId: "mock", modelId: "claude-opus-4-8" });
    srv.built.config.setWebuiModels("org:default-org", ["claude-sonnet-4-6"]);
    await srv.built.config.flushScope("org:default-org");
    await srv.built.config.setRuntimeSelectionLatest("personal:alice", {
      harnessId: "mock",
      modelId: "claude-haiku-4-5",
    });
    const turn = (threadRef: string, model?: string) =>
      srv.built.app.turn({
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef },
        text: "hello",
        ...(model ? { model } : {}),
        async: true,
      });

    const stale = await turn("web:alice:stale-override");
    assert.equal(stale.status, "refused");
    assert.match(stale.reason ?? "", /not enabled for the web UI/);

    const explicitOrgDefault = await turn("web:alice:org-default", "claude-opus-4-8");
    assert.equal(explicitOrgDefault.status, "queued");

    await srv.built.config.setRuntimeSelectionLatest("personal:alice", null);
    const inherited = await turn("web:alice:inherited");
    assert.equal(inherited.status, "queued");
  } finally {
    await srv.close();
  }
});
