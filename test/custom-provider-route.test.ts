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

test("model discovery reads compatible listings with protocol credentials", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const srv = start(async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({
      data: [
        { id: "acme-large", name: "Acme Large" },
        { id: "acme-small", display_name: "Acme Small" },
        { id: "acme-large", name: "Duplicate" },
        { id: "unsafe|model", name: "Unsafe ID" },
        { id: "safe-model", name: "Unsafe\nName" },
        { object: "model" },
      ],
    });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        protocol: "openai",
        baseUrl: "https://llm.acme.internal/v1/",
        apiKey: "sk-discovery",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      models: [
        { id: "acme-large", name: "Acme Large" },
        { id: "acme-small", name: "Acme Small" },
        { id: "safe-model" },
      ],
      total: 3,
      truncated: false,
    });
    assert.deepEqual(requests, [{ url: "https://llm.acme.internal/v1/models", authorization: "Bearer sk-discovery" }]);
    const denied = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: USER,
      body: JSON.stringify({ protocol: "openai", baseUrl: "https://llm.acme.internal/v1", apiKey: "secret" }),
    });
    assert.notEqual(denied.status, 200);
    assert.equal(requests.length, 1);
  } finally {
    await srv.close();
  }
});

test("Anthropic model discovery requests the full local limit and reports more pages", async () => {
  let request: { url: string; key: string | null; version: string | null } | undefined;
  const srv = start(async (input, init) => {
    const headers = new Headers(init?.headers);
    request = {
      url: String(input),
      key: headers.get("x-api-key"),
      version: headers.get("anthropic-version"),
    };
    return Response.json({
      data: [{ id: "claude-acme", display_name: "Claude Acme" }],
      has_more: true,
      last_id: "claude-acme",
    });
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        protocol: "anthropic",
        baseUrl: "https://llm.acme.internal",
        apiKey: "sk-ant-discovery",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(request, {
      url: "https://llm.acme.internal/v1/models?limit=200",
      key: "sk-ant-discovery",
      version: "2023-06-01",
    });
    assert.deepEqual(await response.json(), {
      models: [{ id: "claude-acme", name: "Claude Acme" }],
      total: 1,
      truncated: true,
    });
  } finally {
    await srv.close();
  }
});

test("model discovery reuses a saved write-only key", async () => {
  let authorization = "";
  const srv = start(async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ models: [{ id: "saved-model", displayName: "Saved Model" }] });
  });
  try {
    const saved = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(saved.status, 200);
    const response = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        providerId: "acme-gateway",
        protocol: "openai",
        baseUrl: BODY.baseUrl,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(authorization, "Bearer sk-acme-secret");
    assert.deepEqual(((await response.json()) as { models: unknown }).models, [
      { id: "saved-model", name: "Saved Model" },
    ]);
  } finally {
    await srv.close();
  }
});

test("model discovery does not send a saved key to a changed endpoint", async () => {
  let requests = 0;
  const srv = start(async () => {
    requests += 1;
    return Response.json({ data: [{ id: "model" }] });
  });
  try {
    const saved = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(saved.status, 200);
    const response = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        providerId: "acme-gateway",
        protocol: "openai",
        baseUrl: "https://different.acme.internal/v1",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "missing_api_key");
    assert.equal(requests, 0);
  } finally {
    await srv.close();
  }
});

test("model discovery reports missing keys and invalid listings", async () => {
  const srv = start(async () => Response.json({ data: [{ object: "model" }] }));
  try {
    const missing = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ protocol: "openai", baseUrl: BODY.baseUrl }),
    });
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: string }).error, "missing_api_key");
    const invalid = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ protocol: "openai", baseUrl: BODY.baseUrl, apiKey: "sk-invalid-list" }),
    });
    assert.equal(invalid.status, 502);
    assert.equal(((await invalid.json()) as { error: string }).error, "invalid_models_response");
  } finally {
    await srv.close();
  }
});

test("model discovery rejects declared and streamed oversized responses", async () => {
  const oversized = 2 * 1024 * 1024 + 1;
  let mode: "declared" | "streamed" = "declared";
  const srv = start(async () => {
    if (mode === "declared") {
      return new Response("{}", { headers: { "content-length": String(oversized) } });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(oversized));
          controller.close();
        },
      }),
    );
  });
  try {
    for (const nextMode of ["declared", "streamed"] as const) {
      mode = nextMode;
      const response = await fetch(`${srv.base}/v1/admin/custom-providers/models`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ protocol: "openai", baseUrl: BODY.baseUrl, apiKey: "sk-oversized" }),
      });
      assert.equal(response.status, 502);
      assert.equal(((await response.json()) as { error: string }).error, "invalid_models_response");
    }
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
