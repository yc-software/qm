import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };

afterEach(() => setCustomProviders([]));

function start(modelCredentialFetch?: typeof fetch): {
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

    assert.equal(String(resolveModel("custom/acme-gateway/acme-large")?.provider), "acme-gateway");

    const list = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);
    const listBody = await list.text();
    assert.equal(listBody.includes("sk-acme-secret"), false);
    assert.ok(listBody.includes("acme-gateway"));

    const denied = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: USER });
    assert.notEqual(denied.status, 200);

    const del = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);
    assert.equal(resolveModel("custom/acme-gateway/acme-large"), undefined);
  } finally {
    await srv.close();
  }
});

test("key validation refuses an endpoint on a private network address without sending it the key", async (t) => {
  let hits = 0;
  const endpoint = createServer((_req, res) => {
    hits++;
    res.end("{}");
  });
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  t.after(() => endpoint.close());
  const srv = start();
  t.after(srv.close);
  for (const [baseUrl, host] of [
    [`http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`, "127.0.0.1"],
    ["http://169.254.169.254/latest", "169.254.169.254"],
  ]) {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, baseUrl }),
    });
    assert.equal(put.status, 400, baseUrl);
    assert.deepEqual(await put.json(), {
      error: "bad_request",
      message: `${host} is a private network address; a deployment operator can allow this exact origin with PRIVATE_NETWORK_ALLOWED_ORIGINS`,
    });
  }
  assert.equal(hits, 0);
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

test("a key check that cannot reach the endpoint reports why instead of a rejected key", async () => {
  const srv = start(async () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND llm.acme.internal") });
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 400);
    const body = (await put.json()) as { error: string; message: string };
    assert.equal(body.error, "bad_request");
    assert.match(body.message, /^fetch failed <- .*getaddrinfo ENOTFOUND llm\.acme\.internal/);
  } finally {
    await srv.close();
  }
});

test("a key that is not a valid header value is refused without echoing it", async (t) => {
  const srv = start();
  t.after(srv.close);
  const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify({ ...BODY, apiKey: "sk-acme-secret\nX" }),
  });
  assert.equal(put.status, 400);
  const text = await put.text();
  assert.equal(text.includes("sk-acme-secret"), false);
  assert.equal((JSON.parse(text) as { error: string }).error, "bad_request");
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
