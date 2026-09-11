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
import { setCustomProviders } from "../src/model/custom-providers.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

afterEach(() => setCustomProviders([]));

function start(
  config: NonNullable<Parameters<typeof testConfig>[0]>,
  modelCredentialFetch: typeof fetch,
): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "model-discovery-route-")), ...config }), {
    modelCredentialFetch,
  });
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    modelCredentialFetch,
    harnessId: "pi",
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

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

test("discovery diffs the live provider list into known, new, and missing", async () => {
  let liveCalls = 0;
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" }, async (input) => {
    const url = String(input);
    if (url === ANTHROPIC_MODELS_URL) {
      liveCalls++;
      return Response.json({
        data: [
          { id: "claude-x", display_name: "Claude X" },
          { id: "claude-opus-4-8", display_name: "Opus" },
          { id: "claude-nova-9", display_name: "Claude Nova 9" },
        ],
      });
    }
    return new Response(null, { status: 200 });
  });
  try {
    const registered = await fetch(`${srv.base}/v1/admin/custom-providers/acme-direct`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Acme Direct",
        protocol: "anthropic",
        baseUrl: "https://acme.internal/v1",
        models: [{ id: "claude-x", name: "Claude X" }],
        validate: false,
      }),
    });
    assert.equal(registered.status, 200);

    const enabled = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: ["claude-sonnet-5", "claude-opus-4-8"] }),
    });
    assert.equal(enabled.status, 200);

    const first = await fetch(`${srv.base}/v1/admin/model-providers/anthropic/models`, { headers: ADMIN });
    assert.equal(first.status, 200);
    const body = (await first.json()) as {
      provider: string;
      known: Array<{ id: string; displayName: string }>;
      new: Array<{ id: string; displayName: string }>;
      missing: Array<{ id: string; displayName: string }>;
    };
    const ids = (list: Array<{ id: string }>) => list.map((m) => m.id).sort();
    assert.equal(body.provider, "anthropic");
    assert.deepEqual(ids(body.known), ["claude-opus-4-8", "claude-x"]);
    assert.deepEqual(ids(body.new), ["claude-nova-9"]);
    assert.ok(body.known.some((m) => m.id === "claude-x" && m.displayName === "Claude X"));
    assert.ok(body.missing.some((m) => m.id === "claude-sonnet-5"));
    assert.ok(!body.missing.some((m) => m.id === "claude-opus-4-8"));

    const second = await fetch(`${srv.base}/v1/admin/model-providers/anthropic/models`, { headers: ADMIN });
    assert.equal(second.status, 200);
    assert.equal(liveCalls, 1, "the 5-minute cache serves the second request without a live call");
  } finally {
    await srv.close();
  }
});

test("openrouter discovery treats a dynamically fetched catalog model as known, not new", async () => {
  const srv = start({}, async (input) => {
    if (String(input).startsWith("https://openrouter.ai/api/v1/models"))
      return Response.json({ data: [{ id: "z-ai/glm-4.6", name: "GLM 4.6", supported_parameters: ["tools"] }] });
    return new Response(null, { status: 200 });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/openrouter/models`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      known: Array<{ id: string }>;
      new: Array<{ id: string }>;
    };
    assert.ok(
      body.known.some((m) => m.id === "z-ai/glm-4.6"),
      "a model already in the selectable catalog is known",
    );
    assert.ok(!body.new.some((m) => m.id === "z-ai/glm-4.6"), "an already-catalogued model is never reported as new");
  } finally {
    await srv.close();
  }
});

test("discovery flags a default-picker model that the live provider list omits", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" }, async (input) => {
    if (String(input) === ANTHROPIC_MODELS_URL)
      return Response.json({ data: [{ id: "claude-opus-4-8", display_name: "Opus" }] });
    return new Response(null, { status: 200 });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/anthropic/models`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { missing: Array<{ id: string }> };
    assert.ok(
      body.missing.some((m) => m.id === "claude-sonnet-5"),
      "a default anthropic model absent from the live list is missing even with no explicit picker",
    );
    assert.ok(!body.missing.some((m) => m.id === "claude-opus-4-8"), "a model present in the live list is not missing");
  } finally {
    await srv.close();
  }
});

test("discovery fails closed with no key configured", async () => {
  const srv = start({}, async () => new Response(null, { status: 200 }));
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/anthropic/models`, { headers: ADMIN });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: "anthropic", error: "no_key" });
  } finally {
    await srv.close();
  }
});

test("discovery reports an explicit error and never throws on an unreachable provider", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" }, async (input) => {
    if (String(input) === ANTHROPIC_MODELS_URL) return new Response(null, { status: 401 });
    return new Response(null, { status: 200 });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/anthropic/models`, { headers: ADMIN });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: "anthropic", error: "status_401" });
  } finally {
    await srv.close();
  }
});

test("discovery rejects a non-admin actor", async () => {
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" }, async () => Response.json({ data: [] }));
  try {
    const response = await fetch(`${srv.base}/v1/admin/model-providers/anthropic/models`, {
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
    });
    assert.equal(response.status, 403);
  } finally {
    await srv.close();
  }
});
