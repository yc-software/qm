import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };

afterEach(() => setCustomProviders([]));

function start(modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 })): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-route-")) }), {
    modelCredentialFetch,
  });
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    modelCredentialFetch,
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

const BODY = {
  name: "Acme Gateway",
  protocol: "openai",
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large" }],
  apiKey: "sk-acme-secret",
};

test("custom provider lifecycle: register, list, resolve, delete — admin only, no key leakage", async () => {
  const validated: string[] = [];
  const srv = start(async (input) => {
    validated.push(String(input));
    return new Response(null, { status: 200 });
  });
  try {
    // Register (validates against the endpoint's /models).
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 200);
    assert.ok(validated.some((u) => u === "https://llm.acme.internal/v1/models"));
    const putBody = (await put.json()) as { status: { hasKey: boolean } };
    assert.equal(putBody.status.hasKey, true);
    assert.equal(JSON.stringify(putBody).includes("sk-acme-secret"), false);

    // The runtime registry serves the model immediately.
    assert.equal(String(resolveModel("acme-large")?.provider), "acme-gateway");

    // List never leaks the key.
    const list = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);
    const listBody = await list.text();
    assert.equal(listBody.includes("sk-acme-secret"), false);
    assert.ok(listBody.includes("acme-gateway"));

    // Non-admin gets refused.
    const denied = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: USER });
    assert.notEqual(denied.status, 200);

    // Delete disables and clears the registry.
    const del = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);
    assert.equal(resolveModel("acme-large"), undefined);
  } finally {
    await srv.close();
  }
});

test("a rejected key blocks registration unless validate:false", async () => {
  const srv = start(async () => new Response(null, { status: 401 }));
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 400);
    assert.equal(((await put.json()) as { error: string }).error, "invalid_api_key");

    const skip = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(skip.status, 200);
  } finally {
    await srv.close();
  }
});

test("bad specs are refused with a reason", async () => {
  const srv = start();
  try {
    for (const [patch, reason] of [
      [{ models: [] }, /at least one model/],
      [{ protocol: "grpc" }, /protocol/],
      [{ baseUrl: "https://x?y=1" }, /query/],
    ] as const) {
      const res = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ ...BODY, ...patch, validate: false }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { message: string }).message, reason);
    }
    // Reserved slug via the path.
    const reserved = await fetch(`${srv.base}/v1/admin/custom-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(reserved.status, 400);
    assert.match(((await reserved.json()) as { message: string }).message, /reserved/);
  } finally {
    await srv.close();
  }
});

test("a colliding custom model stays selectable and can be set as the org base model", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/dragonapi`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "DragonAPI",
        protocol: "openai",
        baseUrl: "https://dragon.example.com/v1",
        models: [{ id: "gpt-5.6-terra", name: "Dragon Terra" }],
        apiKey: "sk-dragon",
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    const catalog = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(catalog.status, 200);
    const catalogBody = (await catalog.json()) as { models: Array<{ id: string; provider: string }> };
    assert.ok(catalogBody.models.some((m) => m.id === "dragonapi/gpt-5.6-terra" && m.provider === "dragonapi"));

    const before = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as {
      baseModelOptions: Array<{ id: string; provider: string }>;
    };
    assert.ok(
      beforeBody.baseModelOptions.some((m) => m.id === "dragonapi/gpt-5.6-terra" && m.provider === "dragonapi"),
    );

    const bare = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "gpt-5.6-terra" }),
    });
    assert.equal(bare.status, 400);

    const selected = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "dragonapi/gpt-5.6-terra" }),
    });
    assert.equal(selected.status, 200);
    assert.equal(srv.built.config.getBaseModel("org:default-org"), "dragonapi/gpt-5.6-terra");

    const after = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(after.status, 200);
    const afterBody = (await after.json()) as {
      baseModel: string | null;
      runtime: { harnessId: string; modelId: string } | null;
      modelsByHarness: Record<string, Array<{ id: string; provider: string }>>;
    };
    assert.equal(afterBody.baseModel, "dragonapi/gpt-5.6-terra");
    assert.equal(afterBody.runtime?.modelId, "dragonapi/gpt-5.6-terra");
    assert.ok(
      afterBody.modelsByHarness.pi?.some((m) => m.id === "dragonapi/gpt-5.6-terra" && m.provider === "dragonapi"),
    );
  } finally {
    await srv.close();
  }
});

test("two custom providers that share a wire id stay namespaced on the org picker", async () => {
  const srv = start();
  try {
    for (const [id, name] of [
      ["acme-gateway", "Acme"],
      ["other-gw", "Other"],
    ] as const) {
      const put = await fetch(`${srv.base}/v1/admin/custom-providers/${id}`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({
          name,
          protocol: "openai",
          baseUrl: `https://${id}.example.com/v1`,
          models: [{ id: "shared-chat", name: `${name} Shared` }],
          apiKey: `sk-${id}`,
          validate: false,
        }),
      });
      assert.equal(put.status, 200);
    }

    const selected = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-gateway/shared-chat" }),
    });
    assert.equal(selected.status, 200);

    const after = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(after.status, 200);
    const body = (await after.json()) as {
      baseModel: string | null;
      runtime: { modelId: string } | null;
      baseModelOptions: Array<{ id: string; provider: string }>;
    };
    assert.equal(body.baseModel, "acme-gateway/shared-chat");
    assert.equal(body.runtime?.modelId, "acme-gateway/shared-chat");
    assert.ok(body.baseModelOptions.some((m) => m.id === "acme-gateway/shared-chat" && m.provider === "acme-gateway"));
    assert.ok(body.baseModelOptions.some((m) => m.id === "other-gw/shared-chat" && m.provider === "other-gw"));
    assert.ok(!body.baseModelOptions.some((m) => m.id === "shared-chat"));
  } finally {
    await srv.close();
  }
});
